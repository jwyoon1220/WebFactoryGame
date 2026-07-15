// =============================================================================
//  BeltSystem — coordinates all BeltSegments, splitters, and mergers.
//
//  Per-tick contract (order matters for correct one-tile-per-tick semantics):
//    1. advance() every segment. Items move within their own segment only.
//    2. resolveHandoffs(): items sitting at a segment exit are pushed to their
//       downstream sink (belt / splitter / merger). Because advance() already
//       ran, a transferred item lands at the *back* of the downstream segment
//       and is not advanced again this tick — so no item crosses two segments
//       in one tick.
//
//  Segment boundaries are deliberately created at every interaction point
//  (curves, splitter/merger ports, and tiles where an inserter picks up or
//  drops). That keeps all belt<->machine interaction at a segment HEAD or TAIL,
//  which the O(1) pop/push endpoints handle exactly. The BeltSystem exposes
//  `extractFrom` / `insertInto` for the inserter and miner logic to use.
// =============================================================================

import { ItemId } from "@shared/types";
import { BeltSegment } from "./BeltSegment";

/** What a segment's exit feeds into. */
type Sink =
  | { kind: "none" }
  | { kind: "belt"; segmentId: number }
  | { kind: "splitter"; nodeId: number; port: 0 }
  | { kind: "merger"; nodeId: number; port: 0 | 1 };

/** A splitter: one logical input, two balanced outputs. Buffers one item. */
interface SplitterNode {
  id: number;
  buffer: ItemId; // single-item internal buffer, ItemId.None when empty
  rrCursor: 0 | 1; // round-robin output selector
  out: [Sink, Sink]; // two output sinks
  /** Optional per-output item filter (ItemId.None = no filter). */
  filter: [ItemId, ItemId];
}

/** A merger: two inputs, one output. Round-robins which input it services. */
interface MergerNode {
  id: number;
  buffer: ItemId;
  rrCursor: 0 | 1;
  out: Sink;
}

export class BeltSystem {
  private segments = new Map<number, BeltSegment>();
  /** Exit sink for each segment. */
  private sinks = new Map<number, Sink>();
  private splitters = new Map<number, SplitterNode>();
  private mergers = new Map<number, MergerNode>();

  // --- Topology construction ------------------------------------------------

  addSegment(seg: BeltSegment, sink: Sink = { kind: "none" }): void {
    this.segments.set(seg.id, seg);
    this.sinks.set(seg.id, sink);
  }

  setSink(segmentId: number, sink: Sink): void {
    this.sinks.set(segmentId, sink);
  }

  /** Remove a segment (belt tile deleted). Any sinks pointing at it fall back
   *  to "none" on the next rebuild by the caller. */
  removeSegment(segmentId: number): void {
    this.segments.delete(segmentId);
    this.sinks.delete(segmentId);
  }

  addSplitter(node: SplitterNode): void {
    this.splitters.set(node.id, node);
  }

  addMerger(node: MergerNode): void {
    this.mergers.set(node.id, node);
  }

  getSegment(id: number): BeltSegment | undefined {
    return this.segments.get(id);
  }

  // --- Machine / inserter facing endpoints ----------------------------------

  /** Pull the head item off a segment (inserter pickup). ItemId.None if empty. */
  extractFrom(segmentId: number): ItemId {
    const seg = this.segments.get(segmentId);
    if (!seg) return ItemId.None;
    return seg.popHead();
  }

  /** Drop an item onto a segment's tail (miner / inserter drop). */
  insertInto(segmentId: number, item: ItemId): boolean {
    const seg = this.segments.get(segmentId);
    if (!seg || !seg.canAccept()) return false;
    return seg.pushBack(item);
  }

  // --- Tick -----------------------------------------------------------------

  tick(): void {
    // 1. Intra-segment movement (near-O(1) each).
    for (const seg of this.segments.values()) seg.advance();

    // 2. Splitters/mergers first push their buffered item downstream so their
    //    input capacity frees up before segments hand off into them.
    for (const sp of this.splitters.values()) this.flushSplitter(sp);
    for (const mg of this.mergers.values()) this.flushMerger(mg);

    // 3. Segment exits hand off to their sinks.
    for (const seg of this.segments.values()) {
      if (!seg.headReady) continue;
      this.handoff(seg);
    }

    // 4. Mergers pull from their two inputs (round-robin) if buffer is free.
    //    (Merger inputs are modeled as segments whose sink targets the merger.)
  }

  // --- Handoff resolution ---------------------------------------------------

  private handoff(seg: BeltSegment): void {
    const sink = this.sinks.get(seg.id) ?? { kind: "none" };
    switch (sink.kind) {
      case "none":
        return; // dead end: items pile up at the exit (belt backs up naturally)
      case "belt": {
        const next = this.segments.get(sink.segmentId);
        if (next && next.canAccept()) {
          next.pushBack(seg.popHead());
        }
        return;
      }
      case "splitter": {
        const sp = this.splitters.get(sink.nodeId);
        if (sp && sp.buffer === ItemId.None) {
          sp.buffer = seg.popHead();
        }
        return;
      }
      case "merger": {
        const mg = this.mergers.get(sink.nodeId);
        if (mg && mg.buffer === ItemId.None) {
          mg.buffer = seg.popHead();
        }
        return;
      }
    }
  }

  /** Balanced output: try preferred port, then the other; keep item if both full. */
  private flushSplitter(sp: SplitterNode): void {
    if (sp.buffer === ItemId.None) return;
    const order: Array<0 | 1> = sp.rrCursor === 0 ? [0, 1] : [1, 0];
    for (const port of order) {
      if (sp.filter[port] !== ItemId.None && sp.filter[port] !== sp.buffer) continue;
      if (this.pushToSink(sp.out[port], sp.buffer)) {
        sp.buffer = ItemId.None;
        sp.rrCursor = (port ^ 1) as 0 | 1; // alternate next time -> balance
        return;
      }
    }
    // Both outputs blocked -> keep buffered; upstream belt backs up. Correct.
  }

  private flushMerger(mg: MergerNode): void {
    if (mg.buffer === ItemId.None) return;
    if (this.pushToSink(mg.out, mg.buffer)) {
      mg.buffer = ItemId.None;
    }
  }

  /** Route one item into any sink kind. Returns false if the sink is blocked. */
  private pushToSink(sink: Sink, item: ItemId): boolean {
    switch (sink.kind) {
      case "none":
        return false;
      case "belt": {
        const seg = this.segments.get(sink.segmentId);
        if (seg && seg.canAccept()) return seg.pushBack(item);
        return false;
      }
      case "splitter": {
        const sp = this.splitters.get(sink.nodeId);
        if (sp && sp.buffer === ItemId.None) {
          sp.buffer = item;
          return true;
        }
        return false;
      }
      case "merger": {
        const mg = this.mergers.get(sink.nodeId);
        if (mg && mg.buffer === ItemId.None) {
          mg.buffer = item;
          return true;
        }
        return false;
      }
    }
  }
}

export type { Sink, SplitterNode, MergerNode };

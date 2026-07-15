// =============================================================================
//  BeltSegment — the heart of the "Belt Segment Algorithm".
//
//  A *segment* is a maximal run of contiguous belt tiles that behaves as one
//  logical conveyor: same flow direction, no branching, no interaction point in
//  the middle. Instead of simulating every item (O(N) over all belt tiles) we
//  simulate the segment as a single compressed queue.
//
//  Positions are measured in fixed-point "subunits" from the EXIT (front) of the
//  segment. Items are stored front→back as a *gap list*:
//
//      items[0]  ── the head, nearest the exit
//      item.gap  ── free belt space in front of this item's leading edge, i.e.
//                   the distance it may advance before touching the exit line
//                   (for the head) or the item ahead of it (for the rest).
//
//  Why a gap list gives near-O(1) advancement:
//    To shift the whole belt forward by `speed`, we normally would move every
//    item. But in a *flowing* belt the only thing that changes is how close the
//    head is to the exit — every inter-item gap is preserved. So the common case
//    mutates a single number (items[0].gap) and returns. Work is only O(k) over
//    the *compressed prefix* k (items packed nose-to-tail against a blockage),
//    never over the whole belt. A fully jammed belt is O(1) (nothing moves).
// =============================================================================

import { ItemId } from "@shared/types";

/** Subunits per tile. Higher = smoother sub-tile motion for the renderer. */
export const SUBTILE = 256;
/** Center-to-center spacing between packed items (4 items per tile). */
export const ITEM_LEN = SUBTILE / 4;

interface SlotItem {
  item: ItemId;
  /** Free space ahead of this item's leading edge (>= 0). See file header. */
  gap: number;
}

export class BeltSegment {
  readonly id: number;
  /** Total length in subunits (tiles * SUBTILE). */
  readonly length: number;
  /** Advance speed in subunits/tick, derived from the belt tier. */
  speed: number;

  /** Ordered tiles this segment covers, entry→exit (for render + rebuild). */
  readonly tiles: Array<{ x: number; y: number }>;

  /**
   * Belt space consumed from the exit to the trailing edge of the last item.
   * Invariant: usedLength === Σ item.gap + items.length * ITEM_LEN.
   * Maintained incrementally so canAccept()/pushBack() stay O(1).
   */
  private usedLength = 0;
  private items: SlotItem[] = [];

  constructor(id: number, tiles: Array<{ x: number; y: number }>, speedSubPerTick: number) {
    this.id = id;
    this.tiles = tiles;
    this.length = tiles.length * SUBTILE;
    this.speed = speedSubPerTick;
  }

  get itemCount(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** True when the head item has reached the exit and is ready to hand off. */
  get headReady(): boolean {
    return this.items.length > 0 && this.items[0].gap === 0;
  }

  /** The item sitting at the exit, or ItemId.None if none is ready. */
  peekHead(): ItemId {
    return this.headReady ? this.items[0].item : ItemId.None;
  }

  // --- Movement -------------------------------------------------------------

  /**
   * Advance the belt one tick. Near-O(1): the flowing case mutates only the
   * head gap; the compressed case walks only the jammed prefix.
   */
  advance(): void {
    const items = this.items;
    if (items.length === 0) return;

    const head = items[0];
    // Fast path: head has room to move a full step -> every relative gap is
    // preserved, so nothing else changes. This is the steady-state case.
    if (head.gap >= this.speed) {
      head.gap -= this.speed;
      this.usedLength -= this.speed;
      return;
    }

    // Slow path: the head hits the exit; distribute the remaining movement
    // through the compressed prefix only (items whose gap collapses to 0).
    let r = this.speed;
    for (let i = 0; i < items.length && r > 0; i++) {
      const d = Math.min(r, items[i].gap);
      items[i].gap -= d;
      this.usedLength -= d;
      r -= d;
      // If r remains, items[i].gap is now 0 (fully closed): the belt is packed
      // up to here, so we push into the next item. If r hit 0, we stop.
    }
  }

  // --- Insertion (belt tail / drop-off) -------------------------------------

  /** Can a new item be dropped onto the entry end this tick? O(1). */
  canAccept(): boolean {
    return this.length - this.usedLength >= ITEM_LEN;
  }

  /**
   * Drop an item onto the entry (back) end. Precondition: canAccept().
   * The item is placed as far back as space allows; the empty belt in front of
   * it becomes its gap and it flows forward on subsequent ticks.
   */
  pushBack(item: ItemId): boolean {
    const free = this.length - this.usedLength;
    if (free < ITEM_LEN) return false;
    const gap = free - ITEM_LEN;
    this.items.push({ item, gap });
    this.usedLength = this.length; // usedLength_old + gap + ITEM_LEN === length
    return true;
  }

  // --- Extraction (belt head / pickup) --------------------------------------

  /**
   * Remove and return the head item once it has reached the exit. Returns
   * ItemId.None if nothing is ready. Handing the exit space back to the pack is
   * automatic: the new head inherits the departed item's footprint as gap, so
   * usedLength (a back-of-belt measure) is intentionally left unchanged until
   * the next advance() actually shifts the pack forward.
   */
  popHead(): ItemId {
    if (!this.headReady) return ItemId.None;
    const removed = this.items.shift()!;
    if (this.items.length > 0) {
      // New head's gap was measured to the old head's trailing edge; the exit
      // line is ITEM_LEN further, so extend it.
      this.items[0].gap += ITEM_LEN;
    }
    return removed.item;
  }

  // --- Rendering ------------------------------------------------------------

  /**
   * Visit each item with its distance from the exit (0 = at the exit line,
   * `length` = at the entry). The renderer maps this to a position along the
   * belt path for smooth visuals. Front-to-back order.
   */
  forEachItem(cb: (item: ItemId, distFromExit: number) => void): void {
    let dist = 0;
    for (let i = 0; i < this.items.length; i++) {
      dist += this.items[i].gap;
      cb(this.items[i].item, dist);
      dist += ITEM_LEN;
    }
  }

  // --- Persistence ----------------------------------------------------------

  /** Snapshot for debugging / deterministic tests. */
  debugSnapshot(): { usedLength: number; items: SlotItem[] } {
    return { usedLength: this.usedLength, items: this.items.map((s) => ({ ...s })) };
  }
}

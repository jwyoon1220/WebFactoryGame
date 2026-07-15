import { describe, expect, it } from "vitest";
import { BeltSegment, ITEM_LEN, SUBTILE } from "../BeltSegment";
import { ItemId } from "@shared/types";

/** A 4-tile segment moving 1 subunit/tick keeps the math easy to reason about. */
function seg(tiles = 4, speed = 8): BeltSegment {
  const path = Array.from({ length: tiles }, (_, i) => ({ x: i, y: 0 }));
  return new BeltSegment(1, path, speed);
}

describe("BeltSegment", () => {
  it("saturates to full packed capacity over time (entry insertion + flow)", () => {
    // Items enter at the belt tail and flow forward; a jammed belt (never
    // extracted) fills to length/ITEM_LEN items. Filling is physical: insert
    // when there is room, then advance, repeat, until it can hold no more.
    const s = seg(2, 8); // 2 tiles -> capacity 2*SUBTILE/ITEM_LEN = 8 items
    for (let t = 0; t < 2000; t++) {
      if (s.canAccept()) s.pushBack(ItemId.IronOre);
      s.advance();
    }
    expect(s.itemCount).toBe((2 * SUBTILE) / ITEM_LEN);
  });

  it("moves the head to the exit and makes it ready", () => {
    const s = seg(2, 16);
    s.pushBack(ItemId.IronPlate);
    // Advance enough ticks for the item to traverse ~2 tiles.
    for (let i = 0; i < (2 * SUBTILE) / 16 + 2; i++) s.advance();
    expect(s.headReady).toBe(true);
    expect(s.peekHead()).toBe(ItemId.IronPlate);
  });

  it("backs up: a blocked head causes items to queue without loss", () => {
    const s = seg(4, 16);
    // Feed continuously without ever extracting -> the belt backs up and, once
    // saturated, holds exactly its packed capacity and stops accepting.
    for (let i = 0; i < 3000; i++) {
      if (s.canAccept()) s.pushBack(ItemId.Coal);
      s.advance();
    }
    expect(s.itemCount).toBe((4 * SUBTILE) / ITEM_LEN);
    expect(s.headReady).toBe(true);
    expect(s.canAccept()).toBe(false); // full: no more room at the tail
  });

  it("conserves items across pop/advance (FIFO order preserved)", () => {
    const s = seg(3, 32);
    const inOrder = [ItemId.IronOre, ItemId.CopperOre, ItemId.Coal, ItemId.Stone];
    const out: ItemId[] = [];
    let fed = 0;
    // Feed and drain over time.
    for (let t = 0; t < 500 && (fed < inOrder.length || !s.isEmpty); t++) {
      s.advance();
      if (s.headReady) out.push(s.popHead());
      if (fed < inOrder.length && s.canAccept()) s.pushBack(inOrder[fed++]);
    }
    expect(out).toEqual(inOrder);
  });

  it("regression: draining to fully empty repeatedly must not leak capacity", () => {
    // popHead() on the LAST item in a segment must reset usedLength to 0.
    // Before the fix, it left a phantom ITEM_LEN of "used" space behind every
    // time the segment fully drained, so after enough drain-to-empty cycles
    // canAccept() would go permanently false even though the segment was
    // genuinely empty — production would appear to "work at first, then stop"
    // once enough cycles had passed.
    const s = seg(1, 64); // 1 tile, fast enough to drain in a handful of ticks
    const cycles = 20; // far more than (length/ITEM_LEN) = 4, the old leak budget
    for (let c = 0; c < cycles; c++) {
      expect(s.canAccept(), `cycle ${c}: should still accept before insert`).toBe(true);
      expect(s.pushBack(ItemId.IronOre)).toBe(true);
      // Run enough ticks for the single item to reach the exit and be popped.
      for (let t = 0; t < 10 && !s.headReady; t++) s.advance();
      expect(s.headReady, `cycle ${c}: item should have reached the exit`).toBe(true);
      expect(s.popHead()).toBe(ItemId.IronOre);
      expect(s.isEmpty).toBe(true);
    }
    // After many full drain cycles, the segment must still report full
    // capacity available — no leaked "used" space remains.
    expect(s.canAccept()).toBe(true);
  });
});

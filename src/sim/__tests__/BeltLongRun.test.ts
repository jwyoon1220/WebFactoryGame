import { describe, expect, it } from "vitest";
import { ItemId } from "@shared/types";
import { BeltSegment } from "../BeltSegment";
import { BeltSystem } from "../BeltSystem";

/**
 * Regression coverage for "items disappear after a while": chain many 1-tile
 * segments together (WorldState's real topology — one BeltSegment per belt
 * tile), feed the tail continuously, and drain the head whenever it's ready,
 * for a very long run. At every tick, conservation must hold:
 *   fed - drained === total items still sitting in the chain.
 * If it ever breaks, items were silently lost (or duplicated) somewhere in
 * BeltSegment/BeltSystem's tick order.
 */
describe("long-running belt chain conservation", () => {
  it("never loses or duplicates items over 200,000 ticks", () => {
    const CHAIN_LEN = 12;
    const system = new BeltSystem();
    const speed = 8; // tier-0 belt speed in subunits/tick

    for (let i = 1; i <= CHAIN_LEN; i++) {
      const seg = new BeltSegment(i, [{ x: i, y: 0 }], speed);
      system.addSegment(seg);
      if (i > 1) system.setSink(i - 1, { kind: "belt", segmentId: i });
    }

    let fed = 0;
    let drained = 0;

    for (let tick = 0; tick < 200_000; tick++) {
      // Feed the tail whenever there's room (steady producer).
      if (system.insertInto(1, ItemId.IronOre)) fed++;
      system.tick();
      // Drain the head whenever an item is ready (steady consumer).
      if (system.extractFrom(CHAIN_LEN) !== ItemId.None) drained++;

      if (tick % 5_000 === 0 || tick === 199_999) {
        let onChain = 0;
        for (let i = 1; i <= CHAIN_LEN; i++) onChain += system.getSegment(i)!.itemCount;
        expect(fed - drained, `conservation broken at tick ${tick}`).toBe(onChain);
      }
    }

    // Throughput must not have stalled: plenty should still be draining near
    // the end of a 200k-tick run, not just in the first few thousand ticks.
    expect(drained).toBeGreaterThan(1000);
  });

  it("keeps draining steadily in the last 10% of a long run (no late stall)", () => {
    const CHAIN_LEN = 8;
    const system = new BeltSystem();
    const speed = 8;
    for (let i = 1; i <= CHAIN_LEN; i++) {
      const seg = new BeltSegment(i, [{ x: i, y: 0 }], speed);
      system.addSegment(seg);
      if (i > 1) system.setSink(i - 1, { kind: "belt", segmentId: i });
    }

    const TOTAL_TICKS = 120_000;
    const lastWindowStart = TOTAL_TICKS - TOTAL_TICKS / 10;
    let drainedInLastWindow = 0;

    for (let tick = 0; tick < TOTAL_TICKS; tick++) {
      system.insertInto(1, ItemId.IronOre);
      system.tick();
      const got = system.extractFrom(CHAIN_LEN) !== ItemId.None;
      if (got && tick >= lastWindowStart) drainedInLastWindow++;
    }

    expect(drainedInLastWindow).toBeGreaterThan(0);
  });
});

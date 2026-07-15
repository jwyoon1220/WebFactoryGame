import { describe, expect, it } from "vitest";
import { EntityType, ItemId, type Direction, type MachineEntity } from "@shared/types";
import { SimulationEngine } from "@sim/SimulationEngine";
import { WorldState } from "../WorldState";
import { oreAt } from "../WorldGen";

function findOre(seed: number, want: ItemId): { tx: number; ty: number } {
  for (let r = 3; r < 400; r++) {
    for (let ty = -r; ty <= r; ty++) {
      for (let tx = -r; tx <= r; tx++) {
        if (oreAt(seed, tx, ty) === want) return { tx, ty };
      }
    }
  }
  throw new Error("no ore found");
}

/**
 * Regression coverage for "belt items disappear after a while": build a
 * miner -> long belt run -> smelter chain the way a *player* actually does —
 * placing tiles one at a time while the sim keeps ticking (a drag), not all
 * at once before the engine starts — then run it far longer than the earlier
 * ~60s unit test, and assert total ore is conserved at every checkpoint:
 *   mined_total === smelter.input + smelter.output + items still on belts
 * If this ever drops, ore vanished somewhere in the belt/factory-IO pipeline.
 */
describe("factory chain — long run with interleaved placement", () => {
  it("conserves ore end-to-end over 20 minutes of simulated play", () => {
    const seed = 42;
    const engine = new SimulationEngine();
    const world = new WorldState(engine, { current: null, progress: 0, unlocked: [] }, seed);
    engine.onTick(() => world.factoryTick());
    engine.start();

    const E: Direction = 1;
    const ore = findOre(seed, ItemId.IronOre);
    const BELT_COUNT = 10;

    // Place the miner, then tick a bit (like a player pausing after each
    // placement), then drag out belts one at a time with ticks in between —
    // exercising rebuildBeltLinks() repeatedly while the sim is already live.
    expect(world.place(ore.tx, ore.ty, EntityType.Miner, E)).toBe(true);
    for (let i = 0; i < 30; i++) engine.pump(1000 / 60);

    const beltTiles: Array<{ tx: number; ty: number }> = [];
    for (let i = 1; i <= BELT_COUNT; i++) {
      const tx = ore.tx + i;
      const ty = ore.ty;
      expect(world.place(tx, ty, EntityType.Belt, E)).toBe(true);
      beltTiles.push({ tx, ty });
      for (let t = 0; t < 15; t++) engine.pump(1000 / 60);
    }

    expect(world.place(ore.tx + BELT_COUNT + 1, ore.ty, EntityType.Smelter, E)).toBe(true);

    const smelter = world.entityAtTile(ore.tx + BELT_COUNT + 1, ore.ty) as MachineEntity;

    function onBelts(): number {
      let sum = 0;
      for (const { tx, ty } of beltTiles) {
        const segId = world.beltSegmentIdAt(tx, ty);
        if (segId === undefined) continue;
        const seg = world.beltSystem.getSegment(segId);
        if (seg) sum += seg.itemCount;
      }
      return sum;
    }

    const miner = world.entityAtTile(ore.tx, ore.ty) as MachineEntity;
    function totalOre(): number {
      return (
        (miner.output[ItemId.IronOre] ?? 0) +
        (smelter.input[ItemId.IronOre] ?? 0) +
        (smelter.output[ItemId.IronPlate] ?? 0) +
        onBelts()
      );
    }

    // ~20 minutes at 60 TPS, sampled every 10s. Nothing drains this chain (no
    // chest), so the tracked total (unmined ore is not counted) can only stay
    // flat (backpressure) or grow (mining) — a drop means ore was silently
    // destroyed somewhere between the miner and the smelter's output.
    let prevTotal = totalOre();
    expect(prevTotal).toBeGreaterThanOrEqual(0);
    const SAMPLE_TICKS = 600; // 10s
    const SAMPLES = 120; // 20 minutes total
    for (let s = 0; s < SAMPLES; s++) {
      for (let t = 0; t < SAMPLE_TICKS; t++) engine.pump(1000 / 60);
      const total = totalOre();
      expect(total, `ore total dropped at sample ${s} (tick ~${(s + 1) * SAMPLE_TICKS})`).toBeGreaterThanOrEqual(
        prevTotal
      );
      prevTotal = total;
    }

    // And production must have actually progressed, not stalled at zero.
    expect(smelter.output[ItemId.IronPlate] ?? 0).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { EntityType, ItemId, type ChestEntity, type Direction } from "@shared/types";
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
 * Root-cause regression for "belt items stop appearing after a while": a
 * chest placed at the end of a belt line must actually absorb items. Before
 * this fix, factoryTick()'s belt->target step only recognized MachineEntity
 * targets, so a belt feeding a chest would fill to capacity within seconds
 * and backpressure would cascade all the way back to the miner — looking
 * exactly like production "stopping" even though nothing was truly lost.
 */
describe("chest as a belt sink", () => {
  it("absorbs items delivered by a belt instead of backing up forever", () => {
    const seed = 9;
    const engine = new SimulationEngine();
    const world = new WorldState(engine, { current: null, progress: 0, unlocked: [] }, seed);
    engine.onTick(() => world.factoryTick());

    const E: Direction = 1;
    const ore = findOre(seed, ItemId.IronOre);

    expect(world.place(ore.tx, ore.ty, EntityType.Miner, E)).toBe(true);
    expect(world.place(ore.tx + 1, ore.ty, EntityType.Belt, E)).toBe(true);
    expect(world.place(ore.tx + 2, ore.ty, EntityType.Chest, E)).toBe(true);

    engine.start();
    // 2 minutes — comfortably past the point where an unabsorbed chest would
    // have jammed the single-tile belt (capacity 4 items) and halted mining.
    for (let i = 0; i < 60 * 120; i++) engine.pump(1000 / 60);

    const chest = world.entityAtTile(ore.tx + 2, ore.ty) as ChestEntity;
    expect(chest.inventory[ItemId.IronOre] ?? 0).toBeGreaterThan(4);
  });

  it("keeps mining well past the old ~seconds-scale stall point", () => {
    const seed = 9;
    const engine = new SimulationEngine();
    const world = new WorldState(engine, { current: null, progress: 0, unlocked: [] }, seed);
    engine.onTick(() => world.factoryTick());

    const E: Direction = 1;
    const ore = findOre(seed, ItemId.IronOre);
    world.place(ore.tx, ore.ty, EntityType.Miner, E);
    world.place(ore.tx + 1, ore.ty, EntityType.Belt, E);
    world.place(ore.tx + 2, ore.ty, EntityType.Chest, E);

    engine.start();
    for (let i = 0; i < 60 * 10; i++) engine.pump(1000 / 60); // 10s warm-up
    const chest = world.entityAtTile(ore.tx + 2, ore.ty) as ChestEntity;
    const early = chest.inventory[ItemId.IronOre] ?? 0;

    for (let i = 0; i < 60 * 60; i++) engine.pump(1000 / 60); // +60s more
    const later = chest.inventory[ItemId.IronOre] ?? 0;

    // Still accumulating well after the point a jammed chest would have
    // stalled everything — production genuinely continues over time.
    expect(later).toBeGreaterThan(early);
  });
});

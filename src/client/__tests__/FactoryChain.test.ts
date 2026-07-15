import { describe, expect, it } from "vitest";
import { EntityType, ItemId, type Direction } from "@shared/types";
import { SimulationEngine } from "@sim/SimulationEngine";
import { WorldState } from "../WorldState";
import { oreAt } from "../WorldGen";

/** Find a global tile with the given ore for a seed (deterministic worldgen). */
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

describe("factory chain (miner -> belt -> smelter)", () => {
  it("mines iron, carries it on a belt, and smelts plates end to end", () => {
    const seed = 12345;
    const engine = new SimulationEngine();
    const world = new WorldState(engine, { current: null, progress: 0, unlocked: [] }, seed);
    engine.onTick(() => world.factoryTick());

    const E: Direction = 1;
    const ore = findOre(seed, ItemId.IronOre);

    // Lay out miner -> belt -> belt -> smelter, all facing east.
    expect(world.place(ore.tx, ore.ty, EntityType.Miner, E)).toBe(true);
    expect(world.place(ore.tx + 1, ore.ty, EntityType.Belt, E)).toBe(true);
    expect(world.place(ore.tx + 2, ore.ty, EntityType.Belt, E)).toBe(true);
    expect(world.place(ore.tx + 3, ore.ty, EntityType.Smelter, E)).toBe(true);

    engine.start();
    // ~60 s of simulation at 60 TPS. pump() runs one fixed tick per 1/60 s.
    for (let i = 0; i < 60 * 60; i++) engine.pump(1000 / 60);

    const smelter = world.entityAtTile(ore.tx + 3, ore.ty);
    expect(smelter && "output" in smelter).toBe(true);
    const plates = (smelter as { output: Record<number, number> }).output[ItemId.IronPlate] ?? 0;

    // The miner produced ore, the belt delivered it, and the smelter turned it
    // into plates — the whole automation loop actually ran.
    expect(plates).toBeGreaterThan(0);
  });

  it("removing a belt tile stops delivery (topology re-links)", () => {
    const seed = 777;
    const engine = new SimulationEngine();
    const world = new WorldState(engine, { current: null, progress: 0, unlocked: [] }, seed);
    engine.onTick(() => world.factoryTick());
    const E: Direction = 1;
    const ore = findOre(seed, ItemId.IronOre);

    world.place(ore.tx, ore.ty, EntityType.Miner, E);
    world.place(ore.tx + 1, ore.ty, EntityType.Belt, E);
    world.place(ore.tx + 2, ore.ty, EntityType.Smelter, E);
    // Delete the belt: the miner can no longer feed the smelter.
    expect(world.remove(ore.tx + 1, ore.ty)).toBe(true);

    engine.start();
    for (let i = 0; i < 60 * 30; i++) engine.pump(1000 / 60);

    const smelter = world.entityAtTile(ore.tx + 2, ore.ty) as { input: Record<number, number> };
    expect(smelter.input[ItemId.IronOre] ?? 0).toBe(0);
  });
});

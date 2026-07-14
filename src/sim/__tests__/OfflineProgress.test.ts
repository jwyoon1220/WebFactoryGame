import { describe, expect, it } from "vitest";
import { EntityType, ItemId, MachineState, type MachineEntity } from "@shared/types";
import { advanceMachine, recipeFor } from "../MachineSystem";
import { OfflineProgressSimulator, type OfflineWorld } from "../OfflineProgress";
import { RECIPES } from "@shared/recipes";

function smelter(id: number, oreCount: number): MachineEntity {
  return {
    id,
    type: EntityType.Smelter,
    lx: 0,
    ly: 0,
    dir: 1,
    recipe: 1, // iron-plate: 1 ore -> 1 plate over 96 ticks
    input: { [ItemId.IronOre]: oreCount },
    output: {},
    progress: 0,
    state: MachineState.Idle,
    gridId: 0,
  };
}

describe("advanceMachine (shared live/offline math)", () => {
  it("batch-crafts exactly what inputs allow", () => {
    const m = smelter(1, 10);
    const r = recipeFor(m, ItemId.None)!;
    // 10 ore, plenty of time -> 10 plates, input drained.
    const cycles = advanceMachine(m, r, 1, 100 * 96);
    expect(cycles).toBe(10);
    expect(m.output[ItemId.IronPlate]).toBe(10);
    expect(m.input[ItemId.IronOre] ?? 0).toBe(0);
  });

  it("is time-limited when inputs are ample", () => {
    const m = smelter(1, 1000);
    const r = RECIPES[1];
    // Exactly 5 recipe-durations of time -> 5 plates, remainder banked.
    const cycles = advanceMachine(m, r, 1, 5 * 96);
    expect(cycles).toBe(5);
    expect(m.output[ItemId.IronPlate]).toBe(5);
  });

  it("halves throughput at 50% power (brownout)", () => {
    const m = smelter(1, 1000);
    const r = RECIPES[1];
    const cycles = advanceMachine(m, r, 0.5, 10 * 96);
    expect(cycles).toBe(5); // half speed over 10 durations
  });
});

describe("simulateOfflineProgress", () => {
  it("coarse-step offline sim matches tick-by-tick simulation exactly", async () => {
    // Correctness property: fast-forwarding in big coarse steps must yield the
    // SAME machine state as simulating every 1/60s tick. We run both and diff.
    const offlineMachine = smelter(1, 600);
    const world: OfflineWorld = {
      machines: new Map([[1, offlineMachine]]),
      oreUnder: new Map(),
      links: [],
      generatorIds: [],
      labIds: [],
    };
    await new OfflineProgressSimulator(world).simulateOfflineProgress(600);

    // Reference: same machine, advanced one tick at a time for 600s.
    const ref = smelter(1, 600);
    const r = RECIPES[1];
    for (let t = 0; t < 600 * 60; t++) advanceMachine(ref, r, 1, 1);

    expect(offlineMachine.output[ItemId.IronPlate]).toBe(ref.output[ItemId.IronPlate]);
    expect(offlineMachine.input[ItemId.IronOre] ?? 0).toBe(ref.input[ItemId.IronOre] ?? 0);
    // With no belt draining the output, both stall at the output cap (100).
    expect(offlineMachine.output[ItemId.IronPlate]).toBe(100);
  });

  it("respects the offline cap", async () => {
    const world: OfflineWorld = {
      machines: new Map(),
      oreUnder: new Map(),
      links: [],
      generatorIds: [],
      labIds: [],
    };
    const sim = new OfflineProgressSimulator(world);
    const report = await sim.simulateOfflineProgress(999999);
    expect(report.cappedSeconds).toBeGreaterThan(0);
  });
});

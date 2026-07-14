// =============================================================================
//  OfflineProgress — fast-forward the factory after the player was away.
//
//  There is no 24/7 server; the world is frozen at worlds.last_saved_at. On
//  reconnect the client (or a Pages Function) computes gap = now - last_saved_at
//  and replays production over that gap.
//
//  Two hard requirements shape the design:
//    * Mathematical correctness — a smelter fed 1 ore/s for 1h must yield exactly
//      what it would have in real time, respecting input starvation, output
//      caps, and power throttling (same advanceMachine() math as the live tick).
//    * No UI lag — we must not loop 60*3600*hours times synchronously. We use
//      (a) analytic batch crafting (many cycles per arithmetic step) and
//      (b) an ADAPTIVE COARSE timestep, and (c) cooperative time-slicing so the
//      main thread stays responsive (drop into a Worker for very large gaps).
//
//  Transport model: belts/inserters are collapsed into rate-limited "links"
//  (items/sec a producer can push to a consumer). Within a coarse step the link
//  moves up to rate*dt items, so end-to-end chain ratios stay correct while
//  avoiding per-item belt simulation offline.
// =============================================================================

import {
  EntityType,
  ItemId,
  MachineState,
  TICKS_PER_SECOND,
  type Inventory,
  type MachineEntity,
} from "@shared/types";
import { COAL_BURN_TICKS, GENERATOR_OUTPUT_KW, POWER_DRAW, type Recipe } from "@shared/recipes";
import { advanceMachine, recipeFor } from "./MachineSystem";
import { PowerSystem } from "./PowerSystem";

/** Cap how much wall-clock we will ever fast-forward (anti-abuse + bounded work). */
export const MAX_OFFLINE_SECONDS = 8 * 3600; // 8 hours

/** A rate-limited item transfer from one machine's output to another's input. */
export interface TransferLink {
  fromMachineId: number;
  toMachineId: number;
  item: ItemId;
  /** Max items/second this inserter+belt path can carry. */
  ratePerSec: number;
}

/** Everything the simulator needs, extracted from the loaded chunks. */
export interface OfflineWorld {
  machines: Map<number, MachineEntity>;
  /** ore item beneath each miner, keyed by machine id. */
  oreUnder: Map<number, ItemId>;
  links: TransferLink[];
  /** Generators' coal buffers are just their input inventory (ItemId.Coal). */
  generatorIds: number[];
  /** Lab machine ids (consume science, output research units in `output`). */
  labIds: number[];
}

/** Summary handed back to the UI so it can show "while you were away…". */
export interface OfflineReport {
  simulatedSeconds: number;
  cappedSeconds: number; // seconds discarded beyond MAX_OFFLINE_SECONDS
  produced: Inventory; // net items produced across all machines
  researchUnits: number; // lab cycles completed -> science toward current tech
  steps: number; // coarse steps executed (telemetry)
}

/** Yield to the event loop so a long catch-up never freezes the UI. */
const yieldToUI = (): Promise<void> =>
  new Promise((r) => (typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

export class OfflineProgressSimulator {
  private world: OfflineWorld;
  private power = new PowerSystem();

  constructor(world: OfflineWorld) {
    this.world = world;
  }

  /**
   * Fast-forward `gapSeconds` of production.
   *
   * Adaptive stepping: near the boundary of "recently offline" we want fine
   * steps for accuracy; for multi-hour gaps we widen the step because batch
   * crafting math is exact for whole cycles regardless of step size — the only
   * approximation is transport smoothing, which a wider step slightly favors
   * (producers are assumed to keep feeding). We keep steps <= 60s so buffers
   * (INPUT/OUTPUT caps) still gate throughput realistically.
   */
  async simulateOfflineProgress(
    gapSeconds: number,
    opts: { yieldEverySteps?: number } = {}
  ): Promise<OfflineReport> {
    const cappedSeconds = Math.max(0, gapSeconds - MAX_OFFLINE_SECONDS);
    let remaining = Math.min(Math.max(0, gapSeconds), MAX_OFFLINE_SECONDS);

    const report: OfflineReport = {
      simulatedSeconds: remaining,
      cappedSeconds,
      produced: {},
      researchUnits: 0,
      steps: 0,
    };
    if (remaining <= 0) return report;

    const yieldEvery = opts.yieldEverySteps ?? 64;

    while (remaining > 0) {
      // Coarse step size: fine early, coarser for long tails, hard-capped at 60s
      // so buffer caps keep gating throughput as they would in real time.
      const dtSec = Math.min(remaining, remaining > 600 ? 60 : remaining > 60 ? 10 : 1);
      const dtTicks = dtSec * TICKS_PER_SECOND;

      this.stepPower(dtTicks);
      this.stepTransport(dtSec);
      this.stepMachines(dtTicks, report);

      remaining -= dtSec;
      report.steps++;

      if (report.steps % yieldEvery === 0) await yieldToUI();
    }

    return report;
  }

  // --- Power: fuel burn + grid throttle for this coarse step ----------------

  private stepPower(dtTicks: number): void {
    this.power.beginTick();

    // Generators burn coal and supply their grid, bounded by available fuel.
    for (const id of this.world.generatorIds) {
      const g = this.world.machines.get(id);
      if (!g) continue;
      const coal = g.input[ItemId.Coal] ?? 0;
      const burnable = Math.min(coal, Math.ceil(dtTicks / COAL_BURN_TICKS));
      if (burnable > 0) {
        g.input[ItemId.Coal] = coal - burnable;
        // Fraction of the step the generator was actually powered.
        const poweredTicks = Math.min(dtTicks, burnable * COAL_BURN_TICKS);
        this.power.addSupply(g.gridId, GENERATOR_OUTPUT_KW * (poweredTicks / dtTicks));
        g.state = MachineState.Working;
      } else {
        g.state = MachineState.Idle;
      }
    }

    // Demand from every machine that has work queued (has any input or is a miner).
    for (const m of this.world.machines.values()) {
      const draw = POWER_DRAW[m.type];
      if (!draw) continue;
      if (m.gridId === 0) continue; // ungridded/burner: no electric demand
      const hasWork = m.type === EntityType.Miner || Object.values(m.input).some((v) => (v ?? 0) > 0);
      if (hasWork) this.power.addDemand(m.gridId, draw);
    }

    this.power.resolve();
  }

  // --- Transport: rate-limited links move outputs into downstream inputs ----

  private stepTransport(dtSec: number): void {
    for (const link of this.world.links) {
      const src = this.world.machines.get(link.fromMachineId);
      const dst = this.world.machines.get(link.toMachineId);
      if (!src || !dst) continue;
      const available = src.output[link.item] ?? 0;
      if (available <= 0) continue;
      const capacity = Math.floor(link.ratePerSec * dtSec);
      const moved = Math.min(available, capacity);
      if (moved <= 0) continue;
      src.output[link.item] = available - moved;
      dst.input[link.item] = (dst.input[link.item] ?? 0) + moved;
    }
  }

  // --- Machines: batch-craft this coarse step -------------------------------

  private stepMachines(dtTicks: number, report: OfflineReport): void {
    for (const m of this.world.machines.values()) {
      if (m.type === EntityType.Generator) continue; // handled in stepPower

      const recipe: Recipe | null = recipeFor(m, this.world.oreUnder.get(m.id) ?? ItemId.None);
      const throttle = this.power.throttleFor(m.gridId);

      const before = recipe ? recipe.outputs.map((o) => m.output[o.item] ?? 0) : [];
      const cycles = advanceMachine(m, recipe, throttle, dtTicks);

      if (recipe && cycles > 0) {
        recipe.outputs.forEach((o, i) => {
          const producedNow = (m.output[o.item] ?? 0) - before[i];
          if (producedNow > 0) report.produced[o.item] = (report.produced[o.item] ?? 0) + producedNow;
        });
        if (this.world.labIds.includes(m.id)) report.researchUnits += cycles;
      }
    }
  }
}

/**
 * Convenience wrapper matching the requested signature. Given the loaded world
 * and the persisted `lastSavedAt`, computes the gap and applies catch-up.
 */
export async function simulateOfflineProgress(
  world: OfflineWorld,
  lastSavedAtMs: number,
  nowMs: number
): Promise<OfflineReport> {
  const gapSeconds = Math.max(0, (nowMs - lastSavedAtMs) / 1000);
  return new OfflineProgressSimulator(world).simulateOfflineProgress(gapSeconds);
}

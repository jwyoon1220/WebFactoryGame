// =============================================================================
//  SimulationEngine — the fixed 60 TPS game loop, decoupled from rendering.
//
//  Requirement #1: render (Pixi, 60 FPS, vsync-bound) and simulation (60 Hz,
//  fixed step) must be strictly separated. We use the canonical accumulator
//  pattern: the render loop feeds real elapsed time in; the engine consumes it
//  in whole MS_PER_TICK slices. The leftover fraction is exposed as `alpha` so
//  the renderer can interpolate item/machine positions smoothly even though the
//  simulation only advances on discrete ticks.
//
//  The engine owns the authoritative world state and drives, in order:
//    PowerSystem (throttle) -> MachineSystem (craft) -> BeltSystem (logistics).
// =============================================================================

import { MS_PER_TICK, ItemId, EntityType, type MachineEntity } from "@shared/types";
import { BeltSystem } from "./BeltSystem";
import { PowerSystem } from "./PowerSystem";
import { advanceMachine, recipeFor } from "./MachineSystem";
import { POWER_DRAW } from "@shared/recipes";

/** Callback fired once per simulated tick (for dirty tracking, autosave, etc.). */
export type TickHook = (tick: number) => void;

export class SimulationEngine {
  readonly belts = new BeltSystem();
  readonly power = new PowerSystem();

  private accumulatorMs = 0;
  private tick = 0;
  private running = false;
  private tickHooks: TickHook[] = [];

  /** Machines the engine steps each tick (populated from loaded chunks). */
  machines = new Map<number, MachineEntity>();
  oreUnder = new Map<number, ItemId>();

  onTick(hook: TickHook): void {
    this.tickHooks.push(hook);
  }

  /**
   * Feed real elapsed wall time (ms) from the render loop. Runs as many fixed
   * ticks as fit, and returns the interpolation alpha (0..1) for rendering.
   * A frame-time clamp prevents the "spiral of death" after a long stall
   * (e.g. a backgrounded tab) — excess time is dropped, not replayed here;
   * large gaps are the OfflineProgress simulator's job.
   */
  pump(elapsedMs: number): number {
    this.accumulatorMs += Math.min(elapsedMs, 250); // clamp runaway catch-up
    let guard = 0;
    while (this.accumulatorMs >= MS_PER_TICK && guard++ < 8) {
      this.stepOnce();
      this.accumulatorMs -= MS_PER_TICK;
    }
    return this.accumulatorMs / MS_PER_TICK; // render interpolation alpha
  }

  start(): void {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  get currentTick(): number {
    return this.tick;
  }

  /** Advance the authoritative world by exactly one 1/60s tick. */
  private stepOnce(): void {
    if (!this.running) return;

    // 1. Power: reset, register supply/demand, compute per-grid throttle.
    this.power.beginTick();
    for (const m of this.machines.values()) {
      const draw = POWER_DRAW[m.type];
      if (draw && m.gridId !== 0 && (m.type === EntityType.Miner || hasInput(m))) {
        this.power.addDemand(m.gridId, draw);
      }
    }
    this.power.resolve();

    // 2. Machines: craft one tick's worth, throttled by their grid.
    for (const m of this.machines.values()) {
      const recipe = recipeFor(m, this.oreUnder.get(m.id) ?? ItemId.None);
      advanceMachine(m, recipe, this.power.throttleFor(m.gridId), 1);
    }

    // 3. Belts: advance segments + resolve hand-offs (near-O(1) per segment).
    this.belts.tick();

    // 4. Notify observers (dirty-chunk tracking, autosave scheduler, HUD).
    this.tick++;
    for (const h of this.tickHooks) h(this.tick);
  }
}

function hasInput(m: MachineEntity): boolean {
  for (const k in m.input) if ((m.input[k as unknown as ItemId] ?? 0) > 0) return true;
  return false;
}

// =============================================================================
//  MachineSystem — shared crafting math for miners, smelters, assemblers, labs.
//
//  advanceMachine() is written once and used by BOTH the live 60 TPS tick
//  (dtTicks = 1) and the offline fast-forward (dtTicks = thousands). It never
//  loops per tick: it computes how many whole crafting cycles the elapsed time,
//  the input buffer, and the output space allow, then applies them in one shot.
//  This guarantees offline catch-up produces exactly the ratios real-time play
//  would, while staying O(1) regardless of how long the player was away.
// =============================================================================

import { EntityType, ItemId, MachineState, type Inventory, type MachineEntity } from "@shared/types";
import { RECIPES, type Recipe } from "@shared/recipes";

/** How much output the machine may hold before it stops (stack-ish cap). */
const OUTPUT_CAP = 100;

function count(inv: Inventory, item: ItemId): number {
  return inv[item] ?? 0;
}
function add(inv: Inventory, item: ItemId, n: number): void {
  inv[item] = (inv[item] ?? 0) + n;
}
function sub(inv: Inventory, item: ItemId, n: number): void {
  inv[item] = (inv[item] ?? 0) - n;
}

/** Resolve the recipe a machine is running (miner output is ore-dependent). */
export function recipeFor(m: MachineEntity, oreUnder: ItemId): Recipe | null {
  if (m.type === EntityType.Miner) {
    if (oreUnder === ItemId.None) return null;
    // Synthesize a miner recipe that outputs the ore beneath it.
    return { ...RECIPES[0], outputs: [{ item: oreUnder, count: 1 }] };
  }
  if (m.recipe < 0 || m.recipe >= RECIPES.length) return null;
  return RECIPES[m.recipe];
}

/**
 * Advance a machine by `dtTicks` at speed multiplier `power` (0..1).
 * Mutates the machine's buffers/progress/state in place. Returns the number of
 * cycles completed (useful for research accounting and telemetry).
 *
 * The math:
 *   effTicks   = progress + dtTicks * power        (fractional work available)
 *   byTime     = floor(effTicks / recipe.ticks)    (time-limited cycle count)
 *   byInput    = min over inputs floor(have / need) (input-limited)
 *   byOutput   = floor(outputSpace / produce)       (output-limited)
 *   cycles     = min(byTime, byInput, byOutput)
 * Leftover fractional progress is carried only when time was the binding limit.
 */
export function advanceMachine(
  m: MachineEntity,
  recipe: Recipe | null,
  power: number,
  dtTicks: number
): number {
  if (!recipe || power <= 0) {
    m.state = power <= 0 ? MachineState.NoPower : MachineState.Idle;
    // Still bank partial power-less time as nothing; no progress accrues.
    return 0;
  }

  const work = m.progress + dtTicks * power;
  const byTime = Math.floor(work / recipe.ticks);

  // Input-limited cycles.
  let byInput = Infinity;
  for (const inp of recipe.inputs) {
    byInput = Math.min(byInput, Math.floor(count(m.input, inp.item) / inp.count));
  }
  if (recipe.inputs.length === 0) byInput = byTime; // miners have no inputs

  // Output-limited cycles (respect the per-item output cap).
  let byOutput = Infinity;
  for (const out of recipe.outputs) {
    const space = OUTPUT_CAP - count(m.output, out.item);
    byOutput = Math.min(byOutput, Math.floor(space / out.count));
  }

  const cycles = Math.max(0, Math.min(byTime, byInput, byOutput));

  if (cycles > 0) {
    for (const inp of recipe.inputs) sub(m.input, inp.item, inp.count * cycles);
    for (const out of recipe.outputs) add(m.output, out.item, out.count * cycles);
    m.progress = work - cycles * recipe.ticks;
  } else {
    m.progress = work; // bank progress; blocked by input or output
  }

  // Determine reported state for the UI / next-tick decisions.
  if (byInput <= cycles && byInput < byTime) m.state = MachineState.Idle; // starved
  else if (byOutput <= cycles && byOutput < byTime) m.state = MachineState.OutputFull;
  else m.state = MachineState.Working;

  // Clamp banked progress so a long idle period cannot store unbounded work.
  // (Never clamp input buffers here — that would destroy items and make the
  // result depend on step size. Input limits are enforced by inserters/links.)
  if (m.progress > recipe.ticks) m.progress = recipe.ticks;
  return cycles;
}

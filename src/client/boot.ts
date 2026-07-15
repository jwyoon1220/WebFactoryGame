// =============================================================================
//  boot — the reconnection sequence that ties all four systems together.
//
//    load  ->  offline catch-up  ->  live engine + renderer  ->  autosave
//
//  This is deliberately framework-light so the ordering is obvious; App.tsx just
//  renders the HUD around the state this produces.
// =============================================================================

import { Application } from "pixi.js";
import { EntityType, type LoadResponse, type MachineEntity } from "@shared/types";
import { SimulationEngine } from "@sim/SimulationEngine";
import { GameLoop } from "./render/GameLoop";
import { SaveScheduler } from "./SaveScheduler";
import { WorldState } from "./WorldState";
import { createBuildState, type BuildState } from "./BuildState";
import {
  OfflineProgressSimulator,
  type OfflineReport,
  type OfflineWorld,
  type TransferLink,
} from "@sim/OfflineProgress";

export interface BootResult {
  engine: SimulationEngine;
  world: WorldState;
  loop: GameLoop;
  saver: SaveScheduler;
  build: BuildState;
  offline: OfflineReport;
}

/**
 * @param explicitWorldId  a shared/override world id (from `?world=`), or null
 *   to let the server assign a per-IP world. The resolved id comes back in the
 *   load response and is what we save under.
 */
export async function boot(explicitWorldId: string | null, canvas: HTMLCanvasElement): Promise<BootResult> {
  // 1. LOAD authoritative state from D1 via the Pages Function. Omitting
  //    worldId asks the server to resolve one from our IP (login-free).
  const loadUrl = explicitWorldId
    ? `/api/load?worldId=${encodeURIComponent(explicitWorldId)}`
    : `/api/load`;
  const res = await fetch(loadUrl);
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  const data = (await res.json()) as LoadResponse;
  // The server-resolved id (per-IP or explicit) is the one we persist under.
  const worldId = data.world.id;

  const engine = new SimulationEngine();
  // `saver` is created below; the dirty handler closes over it so edits made
  // before it exists are simply ignored (there is nothing to build yet).
  let saver: SaveScheduler | undefined;
  const world = new WorldState(engine, data.research, data.world.seed, (cx, cy) =>
    saver?.markDirty(cx, cy)
  );
  world.ingest(data.chunks);

  // The factory-IO pass (machine<->belt item transfer) runs every sim tick.
  engine.onTick(() => world.factoryTick());

  // 2. OFFLINE CATCH-UP: fast-forward the gap before the player sees anything.
  const gapSeconds = Math.max(0, (data.serverNow - data.world.lastSavedAt) / 1000);
  const offline = await new OfflineProgressSimulator(
    buildOfflineWorld(world)
  ).simulateOfflineProgress(gapSeconds);

  // 3. LIVE engine + Pixi renderer (fixed-step sim decoupled from vsync).
  const app = new Application();
  await app.init({ canvas, antialias: true, background: "#10141c", resizeTo: window });
  const build = createBuildState();
  const loop = new GameLoop(app, engine, world, build);
  loop.start();

  // 4. AUTOSAVE: dirty-chunk flush every 45s + beacon on disconnect.
  saver = new SaveScheduler(worldId, world);
  saver.start();

  return { engine, world, loop, saver, build, offline };
}

/**
 * Collapse the live world into the OfflineWorld the catch-up simulator needs:
 * the machine map, ore lookup, generator/lab ids, and inferred transfer links.
 * (Link inference here is a simple adjacency heuristic; a full build walks the
 * inserter entities and resolves their source/target tiles.)
 */
function buildOfflineWorld(world: WorldState): OfflineWorld {
  const machines = world.machines;
  const generatorIds: number[] = [];
  const labIds: number[] = [];
  const links: TransferLink[] = [];

  for (const m of machines.values()) {
    if (m.type === EntityType.Generator) generatorIds.push(m.id);
    if (m.type === EntityType.Lab) labIds.push(m.id);
  }

  // oreUnder is the same map the engine populated during ingest.
  return { machines, oreUnder: world.oreUnder, links, generatorIds, labIds };
}

/** Re-export for tests / tooling. */
export type { MachineEntity };

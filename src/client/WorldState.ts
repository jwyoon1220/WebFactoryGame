// =============================================================================
//  WorldState — in-memory bridge between persisted chunks and the live engine.
//
//  Holds the loaded ChunkTileData, indexes machine entities into the engine's
//  fast maps, and can re-serialize a chunk on demand for the SaveScheduler.
//  This is the one place that knows how local chunk coordinates map to the
//  global grid and to engine entity ids.
// =============================================================================

import {
  CHUNK_SIZE,
  EntityType,
  ItemId,
  type AnyEntity,
  type ChunkTileData,
  type MachineEntity,
  type ResearchState,
} from "@shared/types";
import type { ChunkSource } from "./SaveScheduler";
import type { SimulationEngine } from "@sim/SimulationEngine";

export class WorldState implements ChunkSource {
  private chunks = new Map<string, ChunkTileData>();

  constructor(
    private readonly engine: SimulationEngine,
    private research: ResearchState
  ) {}

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /** Ingest chunks from /api/load and register their machines with the engine. */
  ingest(chunks: ChunkTileData[]): void {
    for (const chunk of chunks) {
      this.chunks.set(this.key(chunk.cx, chunk.cy), chunk);
      for (const e of chunk.entities) this.indexEntity(chunk, e);
    }
  }

  private indexEntity(chunk: ChunkTileData, e: AnyEntity): void {
    if (isMachine(e)) {
      this.engine.machines.set(e.id, e);
      if (e.type === EntityType.Miner) {
        // Look up the ore under the miner from the static ore layer.
        const idx = e.ly * CHUNK_SIZE + e.lx;
        this.engine.oreUnder.set(e.id, (chunk.ore[idx] as ItemId) ?? ItemId.None);
      }
    }
    // Belts/splitters/inserters are registered with BeltSystem during segment
    // building (omitted here); machines are what the offline sim needs.
  }

  // --- ChunkSource (used by SaveScheduler) ----------------------------------

  serializeChunk(cx: number, cy: number): ChunkTileData {
    const chunk = this.chunks.get(this.key(cx, cy));
    if (!chunk) return { v: 1, cx, cy, ore: [], entities: [] };
    // Machine buffers/progress live on the same object references the engine
    // mutates, so the chunk is already up to date — just return it.
    return chunk;
  }

  getResearch(): ResearchState {
    return this.research;
  }

  getSimTick(): number {
    return this.engine.currentTick;
  }

  /** Expose machines for building the OfflineWorld input. */
  get machines(): Map<number, MachineEntity> {
    return this.engine.machines;
  }

  /** Ore item beneath each miner, keyed by machine id. */
  get oreUnder(): Map<number, ItemId> {
    return this.engine.oreUnder;
  }
}

function isMachine(e: AnyEntity): e is MachineEntity {
  return (
    e.type === EntityType.Miner ||
    e.type === EntityType.Smelter ||
    e.type === EntityType.Assembler ||
    e.type === EntityType.Lab ||
    e.type === EntityType.Generator
  );
}

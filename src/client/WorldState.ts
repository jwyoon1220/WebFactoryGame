// =============================================================================
//  WorldState — in-memory bridge between persisted chunks, the engine, and the
//  build/render layers.
//
//  Responsibilities:
//   * hold loaded ChunkTileData and generate ore lazily from the seed;
//   * place / remove entities, keeping the engine maps, belt segments, and the
//     tile lookup grid in sync, and marking the owning chunk dirty for autosave;
//   * run the "factory IO" pass each tick that moves items between machines and
//     the belts they face (the glue the pure BeltSystem/MachineSystem don't do).
//
//  Belt topology here uses one BeltSegment per belt tile, re-linked on every
//  belt edit. That is simple and correct (items flow, back up, and merge through
//  the same O(1) segment primitives); merging straight runs into longer segments
//  is a later optimization the BeltSegment class already supports.
// =============================================================================

import {
  CHUNK_SIZE,
  EntityType,
  ItemId,
  MachineState,
  TICKS_PER_SECOND,
  type AnyEntity,
  type ChunkTileData,
  type Direction,
  type MachineEntity,
  type ResearchState,
} from "@shared/types";
import { BELT_SPEED_TILES_PER_SEC, RECIPES } from "@shared/recipes";
import { BeltSegment, SUBTILE } from "@sim/BeltSegment";
import type { ChunkSource } from "./SaveScheduler";
import type { SimulationEngine } from "@sim/SimulationEngine";
import { generateChunkOre, oreAt } from "./WorldGen";

/** dx,dy for N,E,S,W. */
const DIR_VEC: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Default recipe a freshly placed machine runs (index into RECIPES). */
const DEFAULT_RECIPE: Partial<Record<EntityType, number>> = {
  [EntityType.Miner]: 0,
  [EntityType.Smelter]: 1, // iron ore -> iron plate
  [EntityType.Assembler]: 3, // iron plate -> iron gear
};

const INPUT_ACCEPT_CAP = 50;

export class WorldState implements ChunkSource {
  private chunks = new Map<string, ChunkTileData>();
  /** Tile -> entity for O(1) adjacency lookups. */
  private entityGrid = new Map<string, AnyEntity>();
  /** Belt tile -> its BeltSegment id. */
  private beltSegAt = new Map<string, number>();
  /** Entity id -> its global tile, for O(1) origin lookup in factoryTick. */
  private idTile = new Map<number, { tx: number; ty: number }>();
  private nextId = 1;
  private nextSegId = 1;

  constructor(
    private readonly engine: SimulationEngine,
    private research: ResearchState,
    private readonly seed: number,
    /** Called with (cx,cy) whenever a chunk changes, for the SaveScheduler. */
    private readonly onDirty: (cx: number, cy: number) => void = () => {}
  ) {}

  private ck(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }
  private tk(tx: number, ty: number): string {
    return `${tx},${ty}`;
  }
  private chunkOf(t: number): number {
    return Math.floor(t / CHUNK_SIZE);
  }

  // --- Loading --------------------------------------------------------------

  ingest(chunks: ChunkTileData[]): void {
    for (const chunk of chunks) {
      this.chunks.set(this.ck(chunk.cx, chunk.cy), chunk);
      for (const e of chunk.entities) {
        this.nextId = Math.max(this.nextId, e.id + 1);
        this.indexEntity(chunk, e);
        this.registerRuntime(chunk, e);
      }
    }
    this.rebuildBeltLinks();
  }

  private indexEntity(chunk: ChunkTileData, e: AnyEntity): void {
    const tx = chunk.cx * CHUNK_SIZE + e.lx;
    const ty = chunk.cy * CHUNK_SIZE + e.ly;
    this.entityGrid.set(this.tk(tx, ty), e);
    this.idTile.set(e.id, { tx, ty });
  }

  /** Register an entity with the engine / belt system (runtime state). */
  private registerRuntime(chunk: ChunkTileData, e: AnyEntity): void {
    if (isMachine(e)) {
      this.engine.machines.set(e.id, e);
      if (e.type === EntityType.Miner) {
        const idx = e.ly * CHUNK_SIZE + e.lx;
        this.engine.oreUnder.set(e.id, (chunk.ore[idx] as ItemId) ?? ItemId.None);
      }
    } else if (e.type === EntityType.Belt) {
      const tx = chunk.cx * CHUNK_SIZE + e.lx;
      const ty = chunk.cy * CHUNK_SIZE + e.ly;
      const segId = this.nextSegId++;
      const speed = (BELT_SPEED_TILES_PER_SEC[e.tier] * SUBTILE) / TICKS_PER_SECOND;
      const seg = new BeltSegment(segId, [{ x: tx, y: ty }], speed);
      this.engine.belts.addSegment(seg);
      this.beltSegAt.set(this.tk(tx, ty), segId);
    }
  }

  // --- Chunk / ore access ---------------------------------------------------

  private ensureChunk(cx: number, cy: number): ChunkTileData {
    const key = this.ck(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = { v: 1, cx, cy, ore: generateChunkOre(this.seed, cx, cy), entities: [] };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Ore at a global tile — from a loaded chunk if present, else generated. */
  oreAtTile(tx: number, ty: number): ItemId {
    const chunk = this.chunks.get(this.ck(this.chunkOf(tx), this.chunkOf(ty)));
    if (chunk && chunk.ore.length) {
      const lx = tx - this.chunkOf(tx) * CHUNK_SIZE;
      const ly = ty - this.chunkOf(ty) * CHUNK_SIZE;
      return (chunk.ore[ly * CHUNK_SIZE + lx] as ItemId) ?? ItemId.None;
    }
    return oreAt(this.seed, tx, ty);
  }

  entityAtTile(tx: number, ty: number): AnyEntity | undefined {
    return this.entityGrid.get(this.tk(tx, ty));
  }

  /** For the renderer: every belt segment (for drawing tiles + moving items). */
  get beltSystem() {
    return this.engine.belts;
  }
  beltSegmentIdAt(tx: number, ty: number): number | undefined {
    return this.beltSegAt.get(this.tk(tx, ty));
  }

  // --- Placement ------------------------------------------------------------

  /** Try to place an entity. Returns true on success. */
  place(tx: number, ty: number, type: EntityType, dir: Direction): boolean {
    if (this.entityGrid.has(this.tk(tx, ty))) return false; // occupied
    if (type === EntityType.Miner && this.oreAtTile(tx, ty) === ItemId.None) return false;

    const cx = this.chunkOf(tx);
    const cy = this.chunkOf(ty);
    const chunk = this.ensureChunk(cx, cy);
    const lx = tx - cx * CHUNK_SIZE;
    const ly = ty - cy * CHUNK_SIZE;
    const id = this.nextId++;

    const e = makeEntity(id, type, lx, ly, dir);
    chunk.entities.push(e);
    this.indexEntity(chunk, e);
    this.registerRuntime(chunk, e);
    if (type === EntityType.Belt) this.rebuildBeltLinks();

    this.onDirty(cx, cy);
    return true;
  }

  /** Remove whatever entity occupies a tile. Returns true if something went. */
  remove(tx: number, ty: number): boolean {
    const e = this.entityGrid.get(this.tk(tx, ty));
    if (!e) return false;
    const cx = this.chunkOf(tx);
    const cy = this.chunkOf(ty);
    const chunk = this.chunks.get(this.ck(cx, cy));
    if (chunk) chunk.entities = chunk.entities.filter((x) => x.id !== e.id);
    this.entityGrid.delete(this.tk(tx, ty));
    this.idTile.delete(e.id);

    if (isMachine(e)) {
      this.engine.machines.delete(e.id);
      this.engine.oreUnder.delete(e.id);
    } else if (e.type === EntityType.Belt) {
      const segId = this.beltSegAt.get(this.tk(tx, ty));
      if (segId !== undefined) this.engine.belts.removeSegment(segId);
      this.beltSegAt.delete(this.tk(tx, ty));
      this.rebuildBeltLinks();
    }
    this.onDirty(cx, cy);
    return true;
  }

  /**
   * Change which recipe a smelter/assembler runs. Resets in-progress work
   * (buffers are kept — a partially-filled input just waits for the new
   * recipe to consume it, or sits unused if it no longer applies).
   */
  setRecipe(tx: number, ty: number, recipeIndex: number): boolean {
    const e = this.entityGrid.get(this.tk(tx, ty));
    if (!e || !isMachine(e) || e.type === EntityType.Miner) return false;
    const recipe = RECIPES[recipeIndex];
    if (!recipe || recipe.machine !== e.type) return false;
    e.recipe = recipeIndex;
    e.progress = 0;
    this.onDirty(this.chunkOf(tx), this.chunkOf(ty));
    return true;
  }

  // --- Belt linking ---------------------------------------------------------

  /** Point each belt's exit at the neighbouring belt it faces (if any). */
  private rebuildBeltLinks(): void {
    for (const [tileKey, segId] of this.beltSegAt) {
      const [tx, ty] = tileKey.split(",").map(Number);
      const e = this.entityGrid.get(tileKey);
      if (!e || e.type !== EntityType.Belt) continue;
      const [dx, dy] = DIR_VEC[e.dir];
      const frontSeg = this.beltSegAt.get(this.tk(tx + dx, ty + dy));
      this.engine.belts.setSink(
        segId,
        frontSeg !== undefined ? { kind: "belt", segmentId: frontSeg } : { kind: "none" }
      );
    }
  }

  // --- Factory IO (runs every sim tick via engine hook) ---------------------

  /**
   * Move items across machine<->belt boundaries the pure systems don't own:
   *   1. a machine ejects finished output onto the belt it faces;
   *   2. a belt whose head faces a machine feeds that machine's input.
   * Belt<->belt flow is already handled inside BeltSystem.tick().
   */
  factoryTick(): void {
    // 1. Machine output -> the belt in front of it.
    for (const m of this.engine.machines.values()) {
      const item = firstItem(m.output);
      if (item === ItemId.None) continue;
      const origin = this.idTile.get(m.id);
      if (!origin) continue;
      const [dx, dy] = DIR_VEC[m.dir];
      const tx = origin.tx + dx;
      const ty = origin.ty + dy;
      const segId = this.beltSegAt.get(this.tk(tx, ty));
      if (segId === undefined) continue;
      const seg = this.engine.belts.getSegment(segId);
      if (seg && seg.canAccept()) {
        seg.pushBack(item);
        m.output[item] = (m.output[item] ?? 0) - 1;
      }
    }

    // 2. Belt head -> machine input (belt must point into the machine).
    for (const [tileKey, segId] of this.beltSegAt) {
      const seg = this.engine.belts.getSegment(segId);
      if (!seg || !seg.headReady) continue;
      const belt = this.entityGrid.get(tileKey);
      if (!belt || belt.type !== EntityType.Belt) continue;
      const [tx, ty] = tileKey.split(",").map(Number);
      const [dx, dy] = DIR_VEC[belt.dir];
      const target = this.entityGrid.get(this.tk(tx + dx, ty + dy));
      if (!target || !isMachine(target)) continue;
      const head = seg.peekHead();
      if (this.machineAccepts(target, head)) {
        seg.popHead();
        target.input[head] = (target.input[head] ?? 0) + 1;
      }
    }
  }

  private machineAccepts(m: MachineEntity, item: ItemId): boolean {
    if (m.recipe < 0 || m.recipe >= RECIPES.length) return false;
    const recipe = RECIPES[m.recipe];
    if (!recipe.inputs.some((i) => i.item === item)) return false;
    return (m.input[item] ?? 0) < INPUT_ACCEPT_CAP;
  }

  // --- ChunkSource ----------------------------------------------------------

  serializeChunk(cx: number, cy: number): ChunkTileData {
    return this.chunks.get(this.ck(cx, cy)) ?? { v: 1, cx, cy, ore: [], entities: [] };
  }
  getResearch(): ResearchState {
    return this.research;
  }
  getSimTick(): number {
    return this.engine.currentTick;
  }
  get machines(): Map<number, MachineEntity> {
    return this.engine.machines;
  }
  get oreUnder(): Map<number, ItemId> {
    return this.engine.oreUnder;
  }
}

// --- helpers -----------------------------------------------------------------

function isMachine(e: AnyEntity): e is MachineEntity {
  return (
    e.type === EntityType.Miner ||
    e.type === EntityType.Smelter ||
    e.type === EntityType.Assembler ||
    e.type === EntityType.Lab ||
    e.type === EntityType.Generator
  );
}

function firstItem(inv: Partial<Record<ItemId, number>>): ItemId {
  for (const k in inv) {
    const id = Number(k) as ItemId;
    if ((inv[id] ?? 0) > 0) return id;
  }
  return ItemId.None;
}

function makeEntity(id: number, type: EntityType, lx: number, ly: number, dir: Direction): AnyEntity {
  if (type === EntityType.Belt) {
    return { id, type: EntityType.Belt, lx, ly, dir, tier: 0 };
  }
  if (isMachineType(type)) {
    return {
      id,
      type,
      lx,
      ly,
      dir,
      recipe: DEFAULT_RECIPE[type] ?? -1,
      input: {},
      output: {},
      progress: 0,
      state: MachineState.Idle,
      gridId: 0,
    } as MachineEntity;
  }
  // Chest fallback for anything else placeable in this MVP.
  return { id, type: EntityType.Chest, lx, ly, dir, inventory: {}, slots: 16 };
}

function isMachineType(t: EntityType): boolean {
  return (
    t === EntityType.Miner ||
    t === EntityType.Smelter ||
    t === EntityType.Assembler ||
    t === EntityType.Lab ||
    t === EntityType.Generator
  );
}

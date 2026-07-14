// =============================================================================
//  Shared domain types — single source of truth for client, sim, and API.
//
//  The `ChunkTileData` tree at the bottom is exactly what gets JSON.stringify'd
//  into `map_chunks.tile_data`. Keep it flat, numeric, and stable: every field
//  is persisted, so renames require a schema_version bump + migration.
// =============================================================================

// --- Geometry ----------------------------------------------------------------

/** Cardinal orientation. 0=N, 1=E, 2=S, 3=W. Rotations are (dir+1)&3. */
export type Direction = 0 | 1 | 2 | 3;

export const CHUNK_SIZE = 16;
/** Simulation runs at a fixed 60 Hz. One tick == 1000/60 ms. */
export const TICKS_PER_SECOND = 60;
export const MS_PER_TICK = 1000 / TICKS_PER_SECOND;

/** Absolute tile coordinate on the infinite grid. */
export interface TilePos {
  x: number;
  y: number;
}

// --- Items -------------------------------------------------------------------

/** Item kinds are interned to small integers so belts/inventories stay compact. */
export enum ItemId {
  None = 0,
  IronOre = 1,
  CopperOre = 2,
  Coal = 3,
  Stone = 4,
  IronPlate = 10,
  CopperPlate = 11,
  IronGear = 20,
  CopperCable = 21,
  Circuit = 22,
  SciencePackRed = 40, // automation science
  SciencePackGreen = 41, // logistic science
}

// --- Entities ----------------------------------------------------------------

/** Every placeable machine/logistic device. Stored as a small int in JSON. */
export enum EntityType {
  Belt = 1,
  Splitter = 2,
  Merger = 3,
  Miner = 10, // mining drill over an ore tile
  Inserter = 20, // moves 1 item between adjacent tiles
  LongInserter = 21, // reaches 2 tiles (unlocked via tech)
  FilterInserter = 22, // only moves a configured item
  Smelter = 30, // ore -> plate
  Assembler = 31, // recipe -> product
  Lab = 40, // consumes science packs -> research
  Chest = 50, // passive storage
  PowerPole = 60, // extends the power grid
  Generator = 61, // produces power (burns coal)
}

/** Runtime operating state of a machine — persisted so offline sim can resume. */
export enum MachineState {
  Idle = 0, // no work available (starved of input or output blocked)
  Working = 1, // actively crafting / mining
  NoPower = 2, // in a power-deficient grid, throttled or stopped
  OutputFull = 3, // finished a cycle but cannot eject the product
}

/**
 * A compact inventory buffer: item id -> count. Machines keep tiny fixed-slot
 * buffers (a few input stacks + one output stack), so a plain record stays
 * cheap to serialize. Absent keys mean zero.
 */
export type Inventory = Partial<Record<ItemId, number>>;

/** Fields shared by every entity, both in memory and in `tile_data`. */
export interface BaseEntity {
  /** World-unique, stable across saves. Assigned by the entity allocator. */
  id: number;
  type: EntityType;
  /** Local coordinate within the chunk: 0..15. */
  lx: number;
  ly: number;
  dir: Direction;
}

/** Belts do not store items here — items live in BeltSegments (Step 3). This
 *  record only marks the tile as belt and remembers its tier/direction so the
 *  BeltSystem can rebuild segments on load. */
export interface BeltEntity extends BaseEntity {
  type: EntityType.Belt;
  /** Belt tier index -> speed lookup (0 = yellow, 1 = red, 2 = blue). */
  tier: number;
}

export interface SplitterEntity extends BaseEntity {
  type: EntityType.Splitter | EntityType.Merger;
  tier: number;
  /** Round-robin cursor persisted so balancing survives save/load. */
  rrCursor: number;
}

/** A machine that transforms inputs to outputs over a number of ticks. */
export interface MachineEntity extends BaseEntity {
  type:
    | EntityType.Miner
    | EntityType.Smelter
    | EntityType.Assembler
    | EntityType.Lab
    | EntityType.Generator;
  /** Recipe currently configured (index into RECIPES). -1 = none. */
  recipe: number;
  /** Input + output buffers. */
  input: Inventory;
  output: Inventory;
  /** Ticks accumulated toward the current crafting cycle. */
  progress: number;
  state: MachineState;
  /** Grid id this machine draws power from (assigned by PowerSystem). */
  gridId: number;
}

export interface InserterEntity extends BaseEntity {
  type: EntityType.Inserter | EntityType.LongInserter | EntityType.FilterInserter;
  /** Item currently held mid-swing, or ItemId.None. */
  held: ItemId;
  heldCount: number;
  progress: number; // swing progress in ticks
  state: MachineState;
  /** For FilterInserter: only this item is picked up (ItemId.None = any). */
  filter: ItemId;
  gridId: number;
}

export interface ChestEntity extends BaseEntity {
  type: EntityType.Chest;
  inventory: Inventory;
  /** Max stacks; used to reject inserter pushes when full. */
  slots: number;
}

export interface PowerPoleEntity extends BaseEntity {
  type: EntityType.PowerPole;
  gridId: number;
}

/** Discriminated union of everything that can appear in a chunk. */
export type AnyEntity =
  | BeltEntity
  | SplitterEntity
  | MachineEntity
  | InserterEntity
  | ChestEntity
  | PowerPoleEntity;

// --- Chunk serialization (the `tile_data` blob) ------------------------------

/**
 * Exactly what is JSON.stringify'd into map_chunks.tile_data.
 *
 * `v` guards forward-compatibility. `ore` is the static ore layer generated
 * from the world seed (row-major, length CHUNK_SIZE*CHUNK_SIZE); it lets miners
 * resume without re-generating. `entities` is the sparse list of everything the
 * player has built in this chunk.
 */
export interface ChunkTileData {
  v: number; // tile_data schema version
  cx: number;
  cy: number;
  /** Static ore map, row-major ItemId per tile. Empty array = no ore here. */
  ore: number[];
  entities: AnyEntity[];
}

// --- Global (non-spatial) world state ----------------------------------------

/** Serialized into worlds.research_json. */
export interface ResearchState {
  /** Tech currently being researched (id into TECHS), or null. */
  current: string | null;
  /** Science units accumulated toward `current`. */
  progress: number;
  /** Set of unlocked tech ids. */
  unlocked: string[];
}

// --- API payloads ------------------------------------------------------------

/** POST /api/save request body. */
export interface SavePayload {
  worldId: string;
  /** Client's monotonic tick at the moment of save. */
  simTick: number;
  research: ResearchState;
  /** Only dirty chunks are sent. */
  chunks: ChunkTileData[];
}

/** GET /api/load response body. */
export interface LoadResponse {
  world: {
    id: string;
    name: string;
    seed: number;
    simTick: number;
    lastSavedAt: number; // epoch ms — offline-sim anchor
    schemaVersion: number;
  };
  research: ResearchState;
  chunks: ChunkTileData[];
  /** Server-authoritative "now" so the client can compute the offline gap. */
  serverNow: number;
}

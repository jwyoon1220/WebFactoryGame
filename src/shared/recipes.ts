// =============================================================================
//  Recipe & technology definitions.
//
//  These tables are pure data and are shared verbatim between the live 60 TPS
//  simulation and the offline fast-forward simulator, guaranteeing that catch-up
//  math produces exactly the same ratios as real-time play.
// =============================================================================

import { EntityType, ItemId } from "./types";

/** A crafting recipe: consume `inputs`, produce `outputs`, over `ticks`. */
export interface Recipe {
  id: number;
  name: string;
  /** Machine category that can run this recipe. */
  machine: EntityType;
  inputs: Array<{ item: ItemId; count: number }>;
  outputs: Array<{ item: ItemId; count: number }>;
  /** Base crafting time in ticks at 1.0x machine speed / full power. */
  ticks: number;
}

/** Indexed by recipe id === array position. */
export const RECIPES: Recipe[] = [
  // 0: Miner is special — it produces the ore under it. Encoded with no inputs;
  //    the actual output item is resolved from the ore layer at runtime.
  {
    id: 0,
    name: "mine",
    machine: EntityType.Miner,
    inputs: [],
    outputs: [], // resolved dynamically from the ore tile
    ticks: 60, // 1 ore / second at base speed
  },
  // Smelting
  {
    id: 1,
    name: "iron-plate",
    machine: EntityType.Smelter,
    inputs: [{ item: ItemId.IronOre, count: 1 }],
    outputs: [{ item: ItemId.IronPlate, count: 1 }],
    ticks: 96,
  },
  {
    id: 2,
    name: "copper-plate",
    machine: EntityType.Smelter,
    inputs: [{ item: ItemId.CopperOre, count: 1 }],
    outputs: [{ item: ItemId.CopperPlate, count: 1 }],
    ticks: 96,
  },
  // Assembly
  {
    id: 3,
    name: "iron-gear",
    machine: EntityType.Assembler,
    inputs: [{ item: ItemId.IronPlate, count: 2 }],
    outputs: [{ item: ItemId.IronGear, count: 1 }],
    ticks: 30,
  },
  {
    id: 4,
    name: "copper-cable",
    machine: EntityType.Assembler,
    inputs: [{ item: ItemId.CopperPlate, count: 1 }],
    outputs: [{ item: ItemId.CopperCable, count: 2 }],
    ticks: 30,
  },
  {
    id: 5,
    name: "circuit",
    machine: EntityType.Assembler,
    inputs: [
      { item: ItemId.IronPlate, count: 1 },
      { item: ItemId.CopperCable, count: 3 },
    ],
    outputs: [{ item: ItemId.Circuit, count: 1 }],
    ticks: 30,
  },
  {
    id: 6,
    name: "science-red",
    machine: EntityType.Assembler,
    inputs: [
      { item: ItemId.CopperPlate, count: 1 },
      { item: ItemId.IronGear, count: 1 },
    ],
    outputs: [{ item: ItemId.SciencePackRed, count: 1 }],
    ticks: 60,
  },
  {
    id: 7,
    name: "science-green",
    machine: EntityType.Assembler,
    inputs: [
      { item: ItemId.IronGear, count: 1 },
      { item: ItemId.Circuit, count: 1 },
    ],
    outputs: [{ item: ItemId.SciencePackGreen, count: 1 }],
    ticks: 120,
  },
];

/** Lab research consumes science packs. Amount is "per lab cycle". */
export const LAB_RECIPE = {
  ticks: 60,
  inputs: [
    { item: ItemId.SciencePackRed, count: 1 },
    { item: ItemId.SciencePackGreen, count: 1 },
  ],
} as const;

// --- Technology tree ---------------------------------------------------------

export interface Tech {
  id: string;
  name: string;
  /** Total science units required (each lab cycle yields 1 unit). */
  cost: number;
  requires: string[];
  /** Human-readable unlocks; also consumed by the client to flip flags. */
  unlocks: string[];
}

export const TECHS: Record<string, Tech> = {
  "logistics-2": {
    id: "logistics-2",
    name: "Fast Belts",
    cost: 50,
    requires: [],
    unlocks: ["belt-tier-1"],
  },
  "inserter-long": {
    id: "inserter-long",
    name: "Long-handed Inserters",
    cost: 40,
    requires: [],
    unlocks: ["entity:LongInserter"],
  },
  "inserter-filter": {
    id: "inserter-filter",
    name: "Filter Inserters",
    cost: 80,
    requires: ["inserter-long"],
    unlocks: ["entity:FilterInserter"],
  },
  "power-1": {
    id: "power-1",
    name: "Power Generation",
    cost: 100,
    requires: [],
    unlocks: ["entity:Generator", "entity:PowerPole"],
  },
  "logistics-3": {
    id: "logistics-3",
    name: "Express Belts",
    cost: 200,
    requires: ["logistics-2"],
    unlocks: ["belt-tier-2"],
  },
};

// --- Power model -------------------------------------------------------------

/** Power draw (kW) per machine type while Working. Idle machines draw 0. */
export const POWER_DRAW: Partial<Record<EntityType, number>> = {
  [EntityType.Miner]: 90,
  [EntityType.Smelter]: 180,
  [EntityType.Assembler]: 150,
  [EntityType.Lab]: 60,
  [EntityType.Inserter]: 13,
  [EntityType.LongInserter]: 20,
  [EntityType.FilterInserter]: 15,
};

/** Each generator supplies this many kW while it has fuel. */
export const GENERATOR_OUTPUT_KW = 900;
/** Ticks one unit of coal keeps a generator running. */
export const COAL_BURN_TICKS = 120;

/** Belt speed by tier, in tiles/second. Used to size segment throughput. */
export const BELT_SPEED_TILES_PER_SEC = [1.875, 3.75, 5.625];

// =============================================================================
//  WorldGen — deterministic ore generation from the world seed.
//
//  The ore layer is static and derived purely from (seed, tileX, tileY), so the
//  same chunk always regenerates identically on any client without being sent
//  over the wire until it's actually saved. A cheap value-noise field carves out
//  ore patches; different item types occupy different noise bands.
// =============================================================================

import { CHUNK_SIZE, ItemId } from "@shared/types";

/** Deterministic 2D hash -> [0,1). */
function hash2(seed: number, x: number, y: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise by bilinear-interpolating a coarse hash grid. */
function noise(seed: number, x: number, y: number, scale: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const s = (t: number) => t * t * (3 - 2 * t); // smoothstep
  const a = hash2(seed, x0, y0);
  const b = hash2(seed, x0 + 1, y0);
  const c = hash2(seed, x0, y0 + 1);
  const d = hash2(seed, x0 + 1, y0 + 1);
  const top = a + (b - a) * s(fx);
  const bot = c + (d - c) * s(fx);
  return top + (bot - top) * s(fy);
}

/** Ore at a single global tile, or ItemId.None. */
export function oreAt(seed: number, tileX: number, tileY: number): ItemId {
  // Keep a clear ~5-tile starting area around the origin so a new player has
  // room to build before hitting ore.
  if (Math.abs(tileX) <= 2 && Math.abs(tileY) <= 2) return ItemId.None;

  const iron = noise(seed, tileX, tileY, 6);
  const copper = noise(seed + 101, tileX, tileY, 6);
  const coal = noise(seed + 202, tileX, tileY, 5);
  const stone = noise(seed + 303, tileX, tileY, 7);

  // Highest band above its threshold wins, so patches don't overlap muddily.
  const bands: Array<[number, number, ItemId]> = [
    [iron, 0.72, ItemId.IronOre],
    [copper, 0.74, ItemId.CopperOre],
    [coal, 0.76, ItemId.Coal],
    [stone, 0.78, ItemId.Stone],
  ];
  let best: ItemId = ItemId.None;
  let bestVal = 0;
  for (const [val, thr, id] of bands) {
    if (val > thr && val > bestVal) {
      bestVal = val;
      best = id;
    }
  }
  return best;
}

/** Generate the full row-major ore array for a chunk. */
export function generateChunkOre(seed: number, cx: number, cy: number): number[] {
  const ore = new Array<number>(CHUNK_SIZE * CHUNK_SIZE);
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      ore[ly * CHUNK_SIZE + lx] = oreAt(seed, cx * CHUNK_SIZE + lx, cy * CHUNK_SIZE + ly);
    }
  }
  return ore;
}

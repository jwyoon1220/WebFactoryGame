// =============================================================================
//  GET /api/load?worldId=...&cx0=..&cy0=..&cx1=..&cy1=..
//
//  Loads world header + global research + the chunks inside a viewport window
//  (or all chunks if no window is given). Returns serverNow so the client can
//  compute the offline gap = serverNow - world.lastSavedAt and hand it to the
//  OfflineProgress simulator.
//
//  Range query rides the (world_id, cx, cy) primary key, so pulling a viewport
//  is an index range scan — no full-table read.
// =============================================================================

import type { ChunkTileData, LoadResponse, ResearchState } from "../../src/shared/types";
import { resolveWorldId } from "../../src/server/identity";

interface Env {
  DB: D1Database;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

interface WorldRow {
  id: string;
  name: string;
  seed: number;
  sim_tick: number;
  last_saved_at: number;
  schema_version: number;
  research_json: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  // No worldId query param -> resolve one from the visitor's IP (login-free,
  // per-IP world). An explicit ?worldId= shares/overrides a specific world.
  const worldId = await resolveWorldId(request, url.searchParams.get("worldId"));

  const selectWorld = env.DB.prepare(
    `SELECT id, name, seed, sim_tick, last_saved_at, schema_version, research_json
       FROM worlds WHERE id = ?1`
  );

  // 1. World header (single row).
  let world = await selectWorld.bind(worldId).first<WorldRow>();

  // Auto-provision on first visit: the worldId doubles as a save slot, so if no
  // world exists yet we create a fresh empty one (and a default local player to
  // satisfy the FK) and continue. This makes a brand-new deployment "just work"
  // without a manual seed step. Concurrent first-loads are safe via OR IGNORE.
  if (!world) {
    const now = Date.now();
    const seed = Math.floor(Math.random() * 0x7fffffff);
    const playerId = "local-player";
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT OR IGNORE INTO players (id, email, display_name, created_at, last_login_at)
             VALUES (?1, ?2, 'Engineer', ?3, ?3)`
          )
          .bind(playerId, `${playerId}@local`, now),
        env.DB
          .prepare(
            `INSERT OR IGNORE INTO worlds
               (id, player_id, name, seed, created_at, last_saved_at, sim_tick, schema_version, research_json, tech_json)
             VALUES (?1, ?2, 'New Factory', ?3, ?4, ?4, 0, 1, '{}', '{}')`
          )
          .bind(worldId, playerId, seed, now),
      ]);
    } catch (err) {
      // The most common cause here is missing tables -> tell the operator.
      return json({ error: "db not initialized (run db:init:remote)", detail: String(err) }, 500);
    }
    world = await selectWorld.bind(worldId).first<WorldRow>();
  }

  if (!world) return json({ error: "world could not be created" }, 500);

  // 2. Chunks — either a viewport window or the whole world.
  const hasWindow =
    url.searchParams.has("cx0") &&
    url.searchParams.has("cy0") &&
    url.searchParams.has("cx1") &&
    url.searchParams.has("cy1");

  let chunkRows: { results: Array<{ tile_data: string }> };
  if (hasWindow) {
    const cx0 = Number(url.searchParams.get("cx0"));
    const cy0 = Number(url.searchParams.get("cy0"));
    const cx1 = Number(url.searchParams.get("cx1"));
    const cy1 = Number(url.searchParams.get("cy1"));
    chunkRows = await env.DB.prepare(
      `SELECT tile_data FROM map_chunks
        WHERE world_id = ?1 AND cx BETWEEN ?2 AND ?3 AND cy BETWEEN ?4 AND ?5`
    )
      .bind(worldId, Math.min(cx0, cx1), Math.max(cx0, cx1), Math.min(cy0, cy1), Math.max(cy0, cy1))
      .all<{ tile_data: string }>();
  } else {
    chunkRows = await env.DB.prepare(`SELECT tile_data FROM map_chunks WHERE world_id = ?1`)
      .bind(worldId)
      .all<{ tile_data: string }>();
  }

  const chunks: ChunkTileData[] = chunkRows.results.map((r) => JSON.parse(r.tile_data) as ChunkTileData);

  let research: ResearchState;
  try {
    research = JSON.parse(world.research_json) as ResearchState;
  } catch {
    research = { current: null, progress: 0, unlocked: [] };
  }

  const body: LoadResponse = {
    world: {
      id: world.id,
      name: world.name,
      seed: world.seed,
      simTick: world.sim_tick,
      lastSavedAt: world.last_saved_at,
      schemaVersion: world.schema_version,
    },
    research,
    chunks,
    serverNow: Date.now(),
  };

  return json(body);
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "GET") return onRequestGet(context);
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
};

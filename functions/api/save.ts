// =============================================================================
//  POST /api/save — persist dirty chunks + global world state.
//
//  Cloudflare Pages Function. Bound to D1 via context.env.DB (see wrangler.toml).
//
//  Write-budget strategy (requirement #2): the client never calls this per tile.
//  It batches *dirty* chunks and flushes them here every 30-60s or on
//  disconnect (navigator.sendBeacon). We collapse the whole flush into a single
//  D1 batch() so many chunk UPSERTs cost one round-trip. Each chunk's live
//  entity state is stored as one JSON blob in map_chunks.tile_data.
//
//  CORS: the SPA and this function share the same origin on Pages, so no CORS
//  headers are needed for the browser to call it. We still send a strict
//  same-origin Content-Type and no Access-Control-Allow-Origin, which keeps the
//  endpoint unreachable cross-origin by default.
// =============================================================================

import type { SavePayload } from "../../src/shared/types";

interface Env {
  DB: D1Database;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let payload: SavePayload;
  try {
    payload = (await request.json()) as SavePayload;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!payload.worldId || !Array.isArray(payload.chunks)) {
    return json({ error: "worldId and chunks[] are required" }, 400);
  }
  // Guard against oversized flushes hammering the write budget.
  if (payload.chunks.length > 4096) {
    return json({ error: "too many chunks in one flush" }, 413);
  }

  const now = Date.now();

  // --- Build one batched write ----------------------------------------------
  // D1 supports UPSERT via ON CONFLICT. WITHOUT ROWID table + composite PK
  // (world_id, cx, cy) makes each chunk a single addressable row.
  const upsertChunk = env.DB.prepare(
    `INSERT INTO map_chunks (world_id, cx, cy, tile_data, entity_count, rev, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
     ON CONFLICT(world_id, cx, cy) DO UPDATE SET
       tile_data    = excluded.tile_data,
       entity_count = excluded.entity_count,
       rev          = map_chunks.rev + 1,
       updated_at   = excluded.updated_at`
  );

  const statements: D1PreparedStatement[] = payload.chunks.map((chunk) =>
    upsertChunk.bind(
      payload.worldId,
      chunk.cx,
      chunk.cy,
      JSON.stringify(chunk), // the entire ChunkTileData blob
      chunk.entities.length,
      now
    )
  );

  // Advance the world clock LAST in the same batch so last_saved_at is the
  // anchor the offline simulator reads on the next load.
  statements.push(
    env.DB.prepare(
      `UPDATE worlds
         SET last_saved_at = ?2,
             sim_tick      = ?3,
             research_json = ?4
       WHERE id = ?1`
    ).bind(
      payload.worldId,
      now,
      payload.simTick | 0,
      JSON.stringify(payload.research ?? {})
    )
  );

  try {
    // Single network round-trip; D1 runs the batch atomically.
    await env.DB.batch(statements);
  } catch (err) {
    return json({ error: "db write failed", detail: String(err) }, 500);
  }

  return json({ ok: true, savedChunks: payload.chunks.length, savedAt: now });
};

// Any non-POST verb: 405 (keeps the endpoint tight; no CORS preflight needed
// because all calls are same-origin).
export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
};

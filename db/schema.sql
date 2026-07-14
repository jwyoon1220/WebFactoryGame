-- =============================================================================
--  Web Factory Game — Cloudflare D1 (SQLite) schema
-- =============================================================================
--  Design goals
--   * D1 is serverless SQLite with a per-invocation write budget. We therefore
--     never persist a row per placed tile. The map is chunked into 16x16 tiles
--     and an entire chunk's live entity state is serialized to a single JSON
--     blob (`tile_data`). Placement/mutation happens purely in-memory on the
--     client/DO; only *dirty* chunks are flushed via bulk UPSERT every 30-60s
--     or on disconnect.
--   * `worlds.last_saved_at` is the anchor for offline-progress fast-forward.
--   * All timestamps are UNIX epoch milliseconds (INTEGER) for cheap deltas.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
--  players — an account / login identity.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,              -- uuid v4
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT 'Engineer',
  created_at    INTEGER NOT NULL,              -- epoch ms
  last_login_at INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
--  worlds — a single factory save owned by one player.
--
--  `last_saved_at` is the authoritative "wall clock" of the simulation. On
--  reconnect the server computes gapMs = now - last_saved_at and fast-forwards
--  (see src/sim/OfflineProgress.ts). `research_json` / `tech_json` hold global,
--  non-spatial state (unlocked techs, science progress, tunables).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worlds (
  id             TEXT PRIMARY KEY,             -- uuid v4
  player_id      TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT 'New Factory',
  seed           INTEGER NOT NULL,             -- deterministic map/ore generation
  created_at     INTEGER NOT NULL,
  last_saved_at  INTEGER NOT NULL,             -- epoch ms; anchor for offline sim
  sim_tick       INTEGER NOT NULL DEFAULT 0,   -- authoritative tick counter (60/s)
  schema_version INTEGER NOT NULL DEFAULT 1,   -- for tile_data migrations
  research_json  TEXT NOT NULL DEFAULT '{}',   -- serialized ResearchState
  tech_json      TEXT NOT NULL DEFAULT '{}',   -- serialized unlocked-tech flags
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_worlds_player ON worlds(player_id);

-- -----------------------------------------------------------------------------
--  map_chunks — one row per 16x16 chunk that has ever been modified.
--
--  Composite PK (world_id, cx, cy) makes the UPSERT target unambiguous and lets
--  a viewport load pull only the chunks it needs via a bounded range query.
--  `tile_data` is a JSON string (ChunkTileData, see src/shared/types.ts).
--  `rev` is bumped on every flush for optimistic concurrency / debugging.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_chunks (
  world_id    TEXT NOT NULL,
  cx          INTEGER NOT NULL,                -- chunk X (floor(tileX / 16))
  cy          INTEGER NOT NULL,                -- chunk Y (floor(tileY / 16))
  tile_data   TEXT NOT NULL,                   -- JSON stringified ChunkTileData
  entity_count INTEGER NOT NULL DEFAULT 0,     -- denormalized for cheap stats
  rev         INTEGER NOT NULL DEFAULT 0,      -- flush revision
  updated_at  INTEGER NOT NULL,               -- epoch ms
  PRIMARY KEY (world_id, cx, cy),
  FOREIGN KEY (world_id) REFERENCES worlds(id) ON DELETE CASCADE
) WITHOUT ROWID;                               -- PK *is* the row; smaller & faster

-- Range-scan chunks for a viewport: WHERE world_id=? AND cx BETWEEN ? AND ?
-- is already served by the PK prefix. This secondary index accelerates the
-- "recently touched chunks" maintenance queries.
CREATE INDEX IF NOT EXISTS idx_chunks_updated ON map_chunks(world_id, updated_at);

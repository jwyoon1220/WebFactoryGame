# Web Factory Game — Architecture & Reference Implementation

A high-performance, web-based 2D factory-automation game (Factorio/Shapez/Mindustry
lineage) built for **Cloudflare Pages + Pages Functions (TypeScript) + Cloudflare D1**,
with a **Pixi.js + React + TypeScript** frontend.

This repository is both an architectural specification and a working, type-checked,
unit-tested reference implementation of the four load-bearing subsystems.

```
┌──────────────────────── Browser (Cloudflare Pages static assets) ────────────────────────┐
│  React (HUD / menus / offline modal)                                                       │
│  Pixi.js render loop (60 FPS, vsync)  ──pump(elapsed)──►  SimulationEngine (fixed 60 TPS)  │
│                                                            ├─ PowerSystem  (grid throttle) │
│                                                            ├─ MachineSystem (batch craft)  │
│                                                            └─ BeltSystem  (O(1) segments)   │
│  SaveScheduler ──(dirty chunks, every 45s / on unload)──► POST /api/save                    │
│  boot() ──(GET /api/load)──► OfflineProgressSimulator (fast-forward the gap)                │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ same-origin fetch (no CORS)
┌──────────────────────── Pages Functions (/functions/api) ────────────────────────────────┐
│  save.ts  ── bulk UPSERT of dirty chunks + world clock, one D1 batch()                      │
│  load.ts  ── world header + research + viewport chunk range scan + serverNow                │
└────────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                  │ context.env.DB
                                          Cloudflare D1 (SQLite)
                                   worlds · players · map_chunks(tile_data JSON)
```

## Running locally

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # vitest: belt algorithm + offline correctness proofs
npm run db:init:local      # create tables in a local D1
npm run dev                # Vite dev server (frontend)
npm run build              # build ./dist
npm run pages:dev          # wrangler pages dev with the D1 binding
```

Set the real `database_id` in `wrangler.toml` after `wrangler d1 create web-factory-db`.

---

## Step 1 — Database schema  ·  [`db/schema.sql`](db/schema.sql) · [`src/shared/types.ts`](src/shared/types.ts)

Three tables: `players`, `worlds`, `map_chunks`.

- The map is **never** stored a row-per-tile. The infinite grid is divided into
  **16×16 chunks**; each chunk's entire live entity state is serialized to a single
  JSON blob in `map_chunks.tile_data`. The composite primary key `(world_id, cx, cy)`
  on a `WITHOUT ROWID` table makes each chunk one addressable UPSERT target and lets a
  viewport load do an **index range scan** rather than a table scan.
- `worlds.last_saved_at` (epoch ms) is the authoritative wall-clock anchor the
  **offline simulator** reads on reconnect.

The exact shape of the `tile_data` blob is the `ChunkTileData` interface, with a
discriminated union of entities carrying **orientation** (`dir`), **inventory buffers**
(`input`/`output`/`inventory`), **operating state** (`MachineState`), and **progress
ticks** (`progress`). See `src/shared/types.ts`.

---

## Step 2 — Save / Load API  ·  [`functions/api/save.ts`](functions/api/save.ts) · [`functions/api/load.ts`](functions/api/load.ts)

- `save.ts` collapses an entire dirty-chunk flush into **one `env.DB.batch()`** of
  `INSERT … ON CONFLICT(world_id,cx,cy) DO UPDATE` statements plus a single world-clock
  update — one network round-trip regardless of how many chunks changed. This is what
  keeps the game under D1's write budget: the client flushes every 30–60 s or on
  disconnect, never per tile placement.
- `load.ts` returns the world header, global research, the requested viewport's chunks
  (range query on the PK), and `serverNow` so the client can compute the offline gap.
- **CORS is avoided structurally:** the SPA and these functions share one origin on
  Pages, so the browser never issues a cross-origin request or a preflight. The
  functions send a strict same-origin `Content-Type` and no `Access-Control-Allow-Origin`,
  leaving them unreachable cross-origin by default. Non-matching verbs return `405`.

---

## Step 3 — Belt logistics (the "Belt Segment Algorithm")  ·  [`src/sim/BeltSegment.ts`](src/sim/BeltSegment.ts) · [`src/sim/BeltSystem.ts`](src/sim/BeltSystem.ts)

Simulating every item on every belt tile is `O(N)` and murders the tick budget. Instead,
contiguous belt tiles are grouped into one logical **segment** simulated as a compressed
queue.

- Items are stored as a **gap list** (front→back), where each item records only the free
  space in front of it. To shift a *flowing* belt forward, the only thing that changes is
  the head's distance to the exit — every inter-item gap is preserved — so `advance()`
  mutates **a single number and returns (O(1))**. Work is `O(k)` only over the *compressed
  prefix* `k` of items jammed nose-to-tail; a fully backed-up belt is `O(1)` (nothing
  moves).
- `canAccept()` / `pushBack()` (tail insertion) and `popHead()` (head extraction) are all
  `O(1)`, maintained via an incremental `usedLength` invariant.
- `BeltSystem` runs **advance-then-handoff** ordering each tick, which guarantees one item
  crosses at most one segment boundary per tick. It routes items through **splitters**
  (one input → two round-robin balanced outputs, with optional per-lane filters) and
  **mergers** (two inputs → one output), with items backing up naturally when a sink is
  blocked.
- Segment boundaries are created at every interaction point (curves, splitter/merger
  ports, inserter pickup/drop tiles) so all belt↔machine interaction lands on an `O(1)`
  segment head or tail.

Correctness is pinned by `src/sim/__tests__/BeltSegment.test.ts`: saturation to exact
packed capacity, back-pressure without item loss, and FIFO conservation across
insert/advance/extract.

---

## Step 4 — Offline progress  ·  [`src/sim/OfflineProgress.ts`](src/sim/OfflineProgress.ts) · [`src/sim/MachineSystem.ts`](src/sim/MachineSystem.ts)

There is no 24/7 server, so on reconnect we fast-forward `gap = serverNow − last_saved_at`.

Two guarantees:

1. **Mathematical correctness.** The crafting math in `advanceMachine()` is written once
   and shared verbatim by the live 60 TPS tick (`dtTicks = 1`) and the offline
   fast-forward (`dtTicks` in the thousands). It never loops per tick — it computes the
   completed cycle count as `min(byTime, byInput, byOutput)` and applies it in one shot,
   respecting input starvation, output caps, and per-grid power throttling. The test
   `coarse-step offline sim matches tick-by-tick simulation exactly` proves the coarse
   fast-forward yields **byte-identical** machine state to simulating every 1/60 s tick.
2. **No UI lag.** An **adaptive coarse timestep** (1 s → 60 s as the gap grows), analytic
   batch crafting, and cooperative time-slicing (`yieldToUI` between step batches) keep an
   8-hour catch-up off the main-thread critical path. Transport is collapsed into
   rate-limited links so chain ratios stay correct without per-item belt simulation.
   `MAX_OFFLINE_SECONDS` caps total fast-forward work.

`simulateOfflineProgress(gapSeconds)` returns an `OfflineReport` (items produced, research
gained) that the React `OfflineModal` shows as "while you were away…".

---

## Technical constraint #1 — 60 FPS render / 60 TPS sim separation  ·  [`src/sim/SimulationEngine.ts`](src/sim/SimulationEngine.ts) · [`src/client/render/GameLoop.ts`](src/client/render/GameLoop.ts)

The Pixi ticker only feeds real elapsed time to `engine.pump(elapsedMs)`, which consumes
it in whole `MS_PER_TICK` slices (fixed-step accumulator) and returns an interpolation
`alpha` for smooth rendering. A frame-time clamp + tick guard prevent the "spiral of
death" after a backgrounded tab — genuinely large gaps are the offline simulator's job,
not the live loop's. The renderer never mutates simulation state.

## Layout

```
db/schema.sql                 Step 1 — D1 schema
functions/api/save.ts         Step 2 — bulk UPSERT flush
functions/api/load.ts         Step 2 — viewport load
src/shared/types.ts           Step 1 — tile_data + entity interfaces
src/shared/recipes.ts         recipes, tech tree, power model (shared data)
src/sim/BeltSegment.ts        Step 3 — O(1) gap-list segment
src/sim/BeltSystem.ts         Step 3 — segment/splitter/merger coordinator
src/sim/MachineSystem.ts      shared batch crafting math (live + offline)
src/sim/PowerSystem.ts        grid supply/demand throttle
src/sim/OfflineProgress.ts    Step 4 — offline fast-forward
src/sim/SimulationEngine.ts   fixed 60 TPS loop
src/client/…                  Pixi render loop, save scheduler, world bridge, React shell
src/sim/__tests__/…           correctness proofs
```

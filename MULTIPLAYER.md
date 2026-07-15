# Identity & Multiplayer Expansion

How players are identified today, and the concrete path to real-time
multiplayer on Cloudflare — designed so the current code is reused, not rewritten.

## Today — login-free, per-IP worlds

Identity lives in exactly one place: [`src/server/identity.ts`](src/server/identity.ts).

- `GET /api/load` with **no** `worldId` → the server hashes the visitor's
  Cloudflare edge IP (`CF-Connecting-IP`, salted SHA-256) into `ip-<16 hex>` and
  auto-provisions a fresh world for it. Each IP transparently gets its own
  persistent factory with zero sign-up.
- `?world=<id>` overrides the IP rule. Two people opening
  `…/?world=friends-base` share one save slot — this is the seed of "rooms".
- `POST /api/save` applies the **same** resolution, so save and load always agree
  on the slot.

**Limits (by design, not bugs):** the IP hash is a convenience identity, not
auth. Shared NAT IPs collide; a rotating IP loses its world; anyone who learns a
`?world=` id can read/write it. Fine for a demo — replaced below for real MP.

```
Browser ──GET /api/load (no worldId)──► resolveWorldId(req) = ip-a1b2c3…
        ◄── world.id: "ip-a1b2c3…", chunks, serverNow ──
        ──POST /api/save (worldId echoed back)──► same slot
```

## Step 1 — real identity (still single-writer)

Swap the IP hash for a signed session, touching only `resolveWorldId`:

1. `POST /api/auth` issues a signed cookie (JWT/HMAC) carrying `playerId`.
2. `resolveWorldId` reads `playerId` from the verified cookie instead of the IP;
   a player↔world mapping (or a `world_members` table) picks the world.
3. `players` already exists in the schema; add `world_members(world_id,
   player_id, role)` for shared ownership.

No simulation or storage changes — the world id is still the only handle the
rest of the system needs.

## Step 2 — real-time shared worlds (Durable Objects)

D1 is durable storage, not a live server, and the browser can't be authoritative
for a shared world (cheating, conflicts). The Cloudflare-native answer is a
**Durable Object (DO) per world** as the authoritative game server. `worldId`
becomes the DO name — which is exactly why identity was funneled through one
function.

```
        players (WebSocket)                     durable, every 30–60s
   ┌───────────────┐  join(worldId)      ┌──────────────────────────┐
   │  Browser A    │◄──────────────────► │  WorldDO  (idFromName     │      ┌────────┐
   │  (render only)│    input intents    │           = worldId)      │─────►│  D1    │
   ├───────────────┤◄──────────────────► │  • authoritative 60 TPS   │ bulk │ chunks │
   │  Browser B    │    tick deltas /    │    SimulationEngine        │◄─────│ upsert │
   └───────────────┘    snapshots        │  • BeltSystem/MachineSys  │ load └────────┘
                                         │  • per-chunk WS fan-out   │
                                         └──────────────────────────┘
```

What changes, and what doesn't:

| Concern | Change |
|---|---|
| **Simulation** | `SimulationEngine`, `BeltSystem`, `MachineSystem`, `PowerSystem` move **as-is** into the DO. They are already pure, tick-based, and framework-free. |
| **Client** | Becomes render + input only: it sends *intents* ("place belt at X,Y"), the DO validates and echoes authoritative deltas. No client-side authority. |
| **Tick** | The DO runs the fixed 60 TPS loop; `alarm()` keeps it alive and drives autosave. Idle worlds hibernate and rehydrate from D1 on next join. |
| **Persistence** | Unchanged: the DO periodically bulk-UPSERTs dirty chunks through the **same** `map_chunks` schema. `save.ts` becomes the DO's storage call. |
| **Offline progress** | Still needed for a world whose DO hibernated: on rehydrate, the DO runs `OfflineProgressSimulator` over `now - last_saved_at` before accepting joins — the identical code path used client-side today. |
| **Sync scope** | Fan-out is per-chunk: a client only receives deltas for chunks in its viewport (the same 16×16 chunking that bounds storage now bounds bandwidth). |

Conflict handling is naturally serialized: a single DO is single-threaded, so
concurrent edits from many players are ordered by arrival — no distributed
locking. Authorization (who may edit which world) reuses the `world_members`
table from Step 1.

### Migration is incremental

1. Ship per-IP worlds (done).
2. Add auth cookie; `resolveWorldId` reads `playerId`. Still single-writer.
3. Introduce `WorldDO`; route `/api/ws?world=…` to `env.WORLD.idFromName(worldId)`.
   Move the sim into it. `save.ts`/`load.ts` become the DO's persistence layer.
4. Thin the client to intents + rendering.

Each step is shippable on its own, and none of them touch the chunk schema or the
simulation math that this repo already proves correct.

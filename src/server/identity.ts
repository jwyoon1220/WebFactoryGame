// =============================================================================
//  identity — resolves which world (save slot / room) a request belongs to.
//
//  Login-free model: a visitor's Cloudflare edge IP is hashed into a stable
//  world id, so every IP transparently gets its own persistent factory. An
//  explicit `?worldId=` (or save payload field) overrides this — that is how two
//  players share one world today, and how a future lobby will hand out room ids.
//
//  IMPORTANT (multiplayer): the IP hash is a convenience identity, NOT auth. It
//  is guessable-resistant (salted SHA-256) but not a security boundary — shared
//  NAT IPs collide and a rotating IP loses its world. Real multiplayer must
//  replace this with a signed session/player token (see MULTIPLAYER.md). Keeping
//  world resolution in one function means that swap touches exactly one place.
// =============================================================================

/** Salt so stored world ids can't be trivially reversed to raw IPs. */
const WORLD_ID_SALT = "web-factory:v1";

/** Max length we accept for a client-supplied world id (defensive). */
const MAX_WORLD_ID = 64;

/**
 * Decide the world id for this request.
 *  - explicit id (query param or payload) wins, trimmed + length-capped;
 *  - otherwise derive `ip-<16 hex>` from the Cloudflare-provided client IP.
 */
export async function resolveWorldId(request: Request, explicit: string | null | undefined): Promise<string> {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed.slice(0, MAX_WORLD_ID);

  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0";

  const hash = await sha256Hex(`${ip}|${WORLD_ID_SALT}`);
  return `ip-${hash.slice(0, 16)}`;
}

/** SHA-256 hex using the Workers-native Web Crypto API. */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}

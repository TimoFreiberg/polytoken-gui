// Server configuration from the environment. Defaults are safe for local dev;
// the deploy (see deploy/) sets PILOT_TOKEN and runs behind `tailscale serve`.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Default server-state dir, XDG-conformant: `$XDG_STATE_HOME/pilot`, falling back to
 *  `~/.local/state/pilot`. This is STATE (persists across restarts, machine-local, not
 *  precious enough for `~/.local/share`) — the archive index here is a source of truth,
 *  not a cache, so it must NOT land under `~/.cache` where a cleaner may wipe it. Works
 *  on macOS + Linux; override wholesale with PILOT_DATA_DIR. */
function defaultDataDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "pilot");
}

export const config = {
  port: Number(process.env.PILOT_PORT ?? 8787),
  // Server-owned data that outlives a restart: VAPID keypair, push subscriptions, and
  // the session archive index. XDG state dir by default (see defaultDataDir).
  dataDir: process.env.PILOT_DATA_DIR ?? defaultDataDir(),
  // Web Push VAPID `sub` claim — must be a real https: or mailto: URL. Apple's push
  // gateway (iOS) rejects placeholder/localhost values with 403 BadJwtToken even
  // though web-push accepts them locally, so SET THIS in any deploy that wants iOS
  // push — e.g. PILOT_VAPID_SUBJECT=https://<your-tailnet-host> or your real mailto:.
  vapidSubject: process.env.PILOT_VAPID_SUBJECT ?? "mailto:pilot@example.com",
  // Bind to loopback by default — `tailscale serve` proxies in over the tailnet,
  // so the server never needs to listen on 0.0.0.0. Set PILOT_HOST=0.0.0.0 only
  // for bare LAN use without Tailscale.
  host: process.env.PILOT_HOST ?? "127.0.0.1",
  // null = no auth (dev). When set, WS clients must present it and /debug is gated.
  token: process.env.PILOT_TOKEN ?? null,
  // Debug/introspection endpoints. On by default; set PILOT_DEBUG=0 to disable.
  debug: process.env.PILOT_DEBUG !== "0",
  // Built client bundle (served in prod; in dev Vite serves it instead).
  clientDist: resolve(import.meta.dir, "../../client/dist"),
  // Max kept-warm pi sessions before the least-recently-focused one is evicted
  // (its services disposed). ≤0 disables the cap. Only the real pi driver honors it.
  warmCap: Number(process.env.PILOT_WARM_CAP ?? 8),
  // Cadence (ms) of the hub's live-refresh ticker, which re-pushes the session list +
  // the focused session's context usage while a turn runs (so the sidebar rows + the
  // composer's context meter climb live instead of freezing until the turn ends).
  // Default 1s; the e2e suite shortens it so a test sees movement quickly.
  liveRefreshMs: Number(process.env.PILOT_LIVE_REFRESH_MS ?? 1000),
};

/** Token check. null token = auth disabled. This is a plain string compare, not a
 *  constant-time one: pilot is single-user behind `tailscale serve`, so a timing
 *  side-channel on the token isn't in the threat model. */
export function tokenOk(provided: string | null | undefined): boolean {
  return config.token === null || provided === config.token;
}

/**
 * Extract the app token from a request. Prefers `Authorization: Bearer <token>` —
 * the right place for a credential — and falls back to a `?token=` query param so
 * hand-curl stays convenient. The app always uses the header, so the token never
 * lands in a URL (and thus not in history, Referer, or any proxy access log).
 */
export function tokenFromRequest(req: Request, url: URL): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return url.searchParams.get("token");
}

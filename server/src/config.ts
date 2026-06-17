// Server configuration from the environment. Defaults are safe for local dev;
// the deploy (see deploy/) sets PILOT_TOKEN and runs behind `tailscale serve`.

import { resolve } from "node:path";

export const config = {
  port: Number(process.env.PILOT_PORT ?? 8787),
  // Server-owned data that outlives a restart: VAPID keypair + push subscriptions.
  // Gitignored (.pilot-data/). Lives at the repo root by default.
  dataDir:
    process.env.PILOT_DATA_DIR ?? resolve(import.meta.dir, "../../.pilot-data"),
  // Web Push VAPID `sub` claim — a mailto: or https: URL identifying the sender.
  vapidSubject: process.env.PILOT_VAPID_SUBJECT ?? "mailto:pilot@localhost",
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
};

/** Constant-time-ish token check. null token = auth disabled. */
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

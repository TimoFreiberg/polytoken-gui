// Pilot server: Bun.serve with a WebSocket control channel, an agent-legible
// /debug introspection surface, an optional auth-token gate, and static serving of
// the built client (so prod is one process behind `tailscale serve`). M0 wires the
// deterministic mock driver; M5 swaps in the real pi-sdk driver behind PilotDriver.

import { type ServerMessage, parseClientMessage } from "@pilot/protocol";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { config, tokenFromRequest, tokenOk } from "./config.js";
import type { PilotDriver } from "./driver.js";
import { SessionHub } from "./hub.js";
import { Logger } from "./log.js";
import { MockDriver } from "./mock-driver.js";
import {
  LockHeldError,
  acquirePidLock,
  mintOrReadServerId,
} from "./pidlock.js";
import { PushService } from "./push.js";
import { serveStatic } from "./static.js";

// Stable per-data-dir identity, minted once and reused across restarts. Used for
// log attribution and the PID lock record. Done before anything else touches the
// data dir so the id is available to the logger from the first line.
const serverId = mintOrReadServerId(config.dataDir);
const log = new Logger({ file: join(config.dataDir, "pilot.log"), serverId });
export { log };

// Acquire the single-server lock BEFORE any store opens the data dir. Two servers
// on one data dir corrupt the archive/worktree/push stores and — the real hazard —
// regenerate the VAPID keypair, silently invalidating every phone's push
// subscription. A live holder aborts startup loud (house rule: crash, don't
// clobber); a stale lock from a crash is reclaimed.
let pidLock: ReturnType<typeof acquirePidLock>;
try {
  pidLock = acquirePidLock(config.dataDir, serverId);
} catch (e) {
  if (e instanceof LockHeldError) {
    log.error("startup aborted — data dir already locked", {
      heldByPid: e.pid,
      dataDir: e.dataDir,
      lockPath: e.lockPath,
    });
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

// Release the lock on every clean exit path. The 'exit' handler is the backstop
// (covers normal return + most signals); SIGINT/SIGTERM re-exit so 'exit' fires.
let released = false;
function releaseLock(): void {
  if (released) return;
  released = true;
  pidLock.release();
}
process.on("exit", releaseLock);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info(`received ${sig} — shutting down`);
    releaseLock();
    process.exit(0);
  });
}

// A pilot host outlives the sessions it drives, so a stray async error from
// third-party pi extension code must not take the whole process down with every
// other session and client. Concretely (D13): an extension's fire-and-forget
// work — e.g. prompt-editor loading prompt history on session_start — can touch
// a `ctx` that went stale mid-await when we swap sessions; pi's ctx getters then
// throw "stale after session replacement", and the unawaited rejection would
// otherwise exit the process.
//
// This is NOT a silent swallow: we log loudly, and a line that recurs is a
// signal to fix the extension or stop loading it in pilot, not noise to ignore.
// uncaughtException is deliberately left to crash — a synchronous uncaught throw
// on the main path is far more likely our own bug, and crashing loud beats
// limping on with corrupted state.
process.on("unhandledRejection", (reason) => {
  log.error(
    "survived an unhandled promise rejection (likely third-party extension " +
      "async); investigate if this recurs",
    {
      reason:
        reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    },
  );
});

interface WsData {
  authed: boolean;
  // One stable send closure per connection, minted in authenticate(). The hub keys its
  // per-connection focus map by this exact reference, so addClient + handleClient MUST
  // receive the same closure (a fresh `(m) => send(ws, m)` per message would look like a
  // different client and lose this connection's focus).
  send: ((msg: ServerMessage) => void) | null;
  unsub: (() => void) | null;
}

// Driver selection. Default is the live pi driver; PILOT_DRIVER=mock forces the
// deterministic mock (used by e2e tests and local UI dev without a running pi).
// The MockDriver import is static so types stay available; the pi SDK is
// dynamic so it never loads in mock mode.
let driver: PilotDriver;
let mock: MockDriver | null = null;
if (process.env.PILOT_DRIVER === "mock") {
  mock = new MockDriver();
  driver = mock;
} else {
  // Reconstruct the interactive-shell env (PATH, tool shims, exported vars) and merge it
  // into process.env BEFORE pi exists — pi's bash tool spawns with `{ ...process.env }`,
  // so this is what makes the agent's shell see the same tools a terminal session has.
  // Mock mode skips it (deterministic + fast e2e/dev). Loud-warns + keeps the launch PATH
  // on failure; never blocks startup. See pi/login-env.ts.
  const { applyLoginEnv } = await import("./pi/login-env.js");
  await applyLoginEnv();
  const { createPiDriver } = await import("./pi/pi-driver.js");
  driver = await createPiDriver();
}
const push = new PushService();
// Arm the greeting as the landing fixture BEFORE the hub is built — the hub seeds its
// landing default from driver.defaultSeed() at construction.
mock?.bootstrap();
const hub = new SessionHub(
  driver,
  (n) => {
    void push.sendToAll(n);
  },
  config.liveRefreshMs,
  serverId,
);

const rawSend = (ws: ServerWebSocket<WsData>, msg: ServerMessage) =>
  ws.send(JSON.stringify(msg));

function authenticate(ws: ServerWebSocket<WsData>): void {
  ws.data.authed = true;
  // Mint one stable send closure for this connection and reuse it for both addClient
  // and every handleClient — the hub identifies the connection by this reference.
  const send = (m: ServerMessage) => rawSend(ws, m);
  ws.data.send = send;
  ws.data.unsub = hub.addClient(send);
  log.info("client connected", { clients: hub.clientCount() });
}

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: config.host,
  idleTimeout: 120,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (
        server.upgrade(req, {
          data: { authed: false, send: null, unsub: null },
        })
      )
        return undefined;
      return new Response("websocket upgrade failed", { status: 426 });
    }

    if (url.pathname === "/health") {
      // `...activity()` adds { running, initializing, busy } — the desktop
      // update-watcher polls `busy` to decide auto-apply vs defer (no token/debug
      // gate here, so a loopback poller can read it without credentials).
      return Response.json({
        ok: true,
        clients: hub.clientCount(),
        ...hub.activity(),
      });
    }

    // Web Push: VAPID key handout, (un)subscribe, and a manual test trigger. Gated
    // by the same app token as everything else (the public key isn't secret, but
    // keeping the surface uniform is simpler). Not behind config.debug — it's a
    // real feature, not introspection.
    if (url.pathname.startsWith("/push/")) {
      if (!tokenOk(tokenFromRequest(req, url)))
        return new Response("unauthorized", { status: 401 });
      try {
        if (url.pathname === "/push/vapid")
          return Response.json({ publicKey: push.publicKey });
        if (url.pathname === "/push/subscribe" && req.method === "POST") {
          push.add(await req.json());
          return Response.json({ ok: true });
        }
        if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
          const { endpoint } = (await req.json()) as { endpoint?: string };
          if (endpoint) push.remove(endpoint);
          return Response.json({ ok: true });
        }
        if (url.pathname === "/push/test" && req.method === "POST") {
          const sent = await push.sendToAll({
            title: "pilot",
            body: "Test push ✅ — if you see this on a closed phone, it works.",
            tag: "pilot-test",
          });
          return Response.json({ ok: true, subscriptions: push.count, sent });
        }
      } catch (e) {
        return new Response(`bad request: ${String(e)}`, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    }

    // Desktop auto-update relay. The update-watcher POSTs whether a new origin/main is
    // staged-and-waiting (body { available, sha?, applyFailed?, desktopStale? }); the hub
    // broadcasts the card to clients and returns { applying, force } so the watcher learns on
    // this same poll whether the user clicked "update now" (force = a force-update was
    // requested). `desktopStale` (running .app vs the clone's HEAD:desktop) rides along to
    // drive the durable rebuild dot. Token-gated like /push (off on the local
    // desktop app; required behind tailscale).
    if (url.pathname === "/update/state" && req.method === "POST") {
      if (!tokenOk(tokenFromRequest(req, url)))
        return new Response("unauthorized", { status: 401 });
      try {
        const body = (await req.json()) as {
          available?: boolean;
          sha?: string;
          applyFailed?: boolean;
          desktopStale?: boolean;
        };
        const sha = body.available ? (body.sha ?? null) : null;
        // Absent desktopStale → undefined → hub leaves its last value untouched (a partial
        // report must not silently clear the dot).
        const desktopStale =
          typeof body.desktopStale === "boolean"
            ? body.desktopStale
            : undefined;
        return Response.json(
          hub.reportUpdate(sha, body.applyFailed === true, desktopStale),
        );
      } catch (e) {
        return new Response(`bad request: ${String(e)}`, { status: 400 });
      }
    }

    if (url.pathname.startsWith("/debug/")) {
      if (!config.debug) return new Response("debug disabled", { status: 404 });
      if (!tokenOk(tokenFromRequest(req, url)))
        return new Response("unauthorized", { status: 401 });
      const headers = { "access-control-allow-origin": "*" };
      if (url.pathname === "/debug/state")
        return Response.json(hub.snapshot(), { headers });
      if (url.pathname === "/debug/reset") {
        hub.reset({
          bootstrap: url.searchParams.get("bootstrap") !== "0",
        });
        return Response.json({ ok: true }, { headers });
      }
      return new Response("not found", { status: 404 });
    }

    // Serve the built client in prod; in dev Vite serves it and proxies here.
    const asset = await serveStatic(url.pathname);
    if (asset) return asset;
    return new Response("pilot server — no client build (run `bun run dev`)", {
      status: 200,
    });
  },

  websocket: {
    open(ws) {
      // No token configured -> open access (dev). Otherwise wait for an authed hello.
      if (config.token === null) authenticate(ws);
    },
    message(ws, raw) {
      const msg = parseClientMessage(
        typeof raw === "string" ? raw : raw.toString(),
      );
      if (!msg) return;
      if (!ws.data.authed) {
        if (msg.type === "hello" && tokenOk(msg.auth)) authenticate(ws);
        else {
          rawSend(ws, { type: "error", message: "unauthorized" });
          ws.close();
        }
        return;
      }
      if (msg.type === "hello") return; // already authed
      // Reuse this connection's stable send so the hub matches it to its focus state.
      if (ws.data.send) hub.handleClient(ws.data.send, msg);
    },
    close(ws) {
      const wasAuthed = ws.data.authed;
      ws.data.unsub?.();
      ws.data.unsub = null;
      ws.data.send = null;
      if (wasAuthed)
        log.info("client disconnected", { clients: hub.clientCount() });
    },
  },
});

log.info("pilot server started", {
  url: `http://${config.host}:${server.port}`,
  dataDir: config.dataDir,
  driver: process.env.PILOT_DRIVER === "mock" ? "mock" : "pi",
  token: config.token ? "required" : "off",
  debug: config.debug,
});

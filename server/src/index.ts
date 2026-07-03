// Pilot server: Bun.serve with a WebSocket control channel, an agent-legible
// /debug introspection surface, an optional auth-token gate, and static serving of
// the built client (so prod is one process behind `tailscale serve`). The default
// driver is the out-of-process polytoken daemon; PILOT_DRIVER=mock selects the
// deterministic mock for e2e + local UI dev.

import {
  parseClientMessage,
  type ResumeToken,
  type ServerMessage,
} from "@pilot/protocol";
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
import { sendJson } from "./ws-send.js";

// Stable per-data-dir identity, minted once and reused across restarts. Used for
// log attribution and the PID lock record. Done before anything else touches the
// data dir so the id is available to the logger from the first line.
const serverId = mintOrReadServerId(config.dataDir);
const log = new Logger({ file: join(config.dataDir, "pilot.log"), serverId });
// Tee global console.* into pilot.log so extension/daemon `console.error` (and
// pilot's own log lines) reach the durable log file in the live desktop app, where the
// process stderr is otherwise unreached (ServerSupervisor attaches no stderr pipe).
// Called before anything logs so nothing is missed; the originals are captured in the
// Logger ctor so its own mirror path never recurses through this tee.
log.captureConsole();
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
// (covers normal return + the failsafe force-exit); the signal handler re-exits so
// 'exit' fires. releaseLock is idempotent, so both paths releasing is safe.
let released = false;
function releaseLock(): void {
  if (released) return;
  released = true;
  pidLock.release();
}
process.on("exit", releaseLock);

// The signal path is a single orchestrator: it must drain driver-owned children (the
// polytoken daemons) via driver.shutdown() BEFORE releasing the lock and exiting, or
// every restart pays the stale-lease recovery path. But `driver` is assigned later via
// a top-level await (daemon-driver construction), so a signal that lands during that
// startup window can't reference it — a module-level `gracefulShutdown` bridges the gap.
// It starts undefined; the listeners fall back to a bare lock-release-and-exit until the
// driver is built and installs the real drain (below the driver construction). Registering
// the listeners once, up front, means a Ctrl-C mid-startup still exits promptly instead of
// being ignored until construction finishes.
let gracefulShutdown: ((sig: string) => void) | undefined;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (gracefulShutdown) {
      gracefulShutdown(sig);
      return;
    }
    // Pre-driver window: nothing to drain yet — release the lock and exit.
    log.info(`received ${sig} during startup — shutting down`);
    releaseLock();
    process.exit(0);
  });
}

// A pilot host outlives the sessions it drives, so a stray async error from
// third-party daemon/extension code must not take the whole process down with every
// other session and client. Concretely: fire-and-forget work can touch a `ctx` that
// went stale mid-await when we swap sessions; the daemon's ctx getters then throw
// "stale after session replacement", and the unawaited rejection would otherwise exit
// the process.
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

// Driver selection. Default is the out-of-process polytoken daemon driver;
// PILOT_DRIVER=mock forces the deterministic mock (used by e2e tests and local UI dev
// without a running daemon). The pi driver has been removed from this branch — setting
// PILOT_DRIVER=pi is a hard error so a stale config surfaces loud rather than silently
// falling through. The MockDriver import is static so types stay available; the
// polytoken driver is dynamic so it never loads in mock mode.
let driver: PilotDriver;
let mock: MockDriver | null = null;
if (process.env.PILOT_DRIVER === "mock") {
  mock = new MockDriver();
  driver = mock;
} else {
  if (process.env.PILOT_DRIVER === "pi")
    throw new Error(
      "pi driver removed on this branch — use 'mock' or 'polytoken' (default)",
    );
  const { createPolytokenDriver } =
    await import("./polytoken/polytoken-driver.js");
  // Wire the warm-pool knobs from config (env-overridable). Previously called with no
  // opts, so PILOT_WARM_CAP was read into config but never honored on this path and
  // PILOT_IDLE_REAP_MS didn't exist — both default to the driver's prior values
  // (8 / 10 min), so this is behavior-preserving unless the env overrides are set.
  driver = await createPolytokenDriver({
    warmCap: config.warmCap,
    idleReapMs: config.idleReapMs,
  });
}

// Driver is now constructed — install the real signal orchestrator (the pre-driver
// listeners above delegate to this). On SIGINT/SIGTERM: drain the driver's children
// (polytoken /terminate + lease release), release the lock, then exit. A wedged drain
// mustn't hang the kill, so a 3s force-exit failsafe is armed BEFORE we await — its
// path still releases the lock (the 'exit' handler runs releaseLock, idempotent). A
// second signal exits immediately rather than stacking drains.
let shuttingDown = false;
gracefulShutdown = (sig: string) => {
  if (shuttingDown) {
    log.info(`received ${sig} again — exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  log.info(`received ${sig} — shutting down`);
  // Armed before the await so a hung driver.shutdown() can't wedge the process.
  setTimeout(() => process.exit(1), 3000).unref();
  void (async () => {
    try {
      await driver.shutdown?.();
    } catch (e) {
      log.error("driver shutdown failed during signal handling", {
        error: e instanceof Error ? (e.stack ?? e.message) : e,
      });
    }
    releaseLock();
    process.exit(0);
  })();
};
const push = new PushService();
// Arm the greeting as the landing fixture BEFORE the hub is built — the hub seeds its
// landing default from driver.defaultSeed() at construction.
mock?.bootstrap();
// Mock mode (e2e + agent UI dev) runs against the same prod entrypoint as the
// live app, so the data-dir "Reveal" button would otherwise spawn a real Finder/
// Explorer window on the host every time a test clicks it. Inject a no-op opener
// here — the real driver path keeps the live spawn (defaultOpenInFileManager).
const openInFileManager = mock ? () => {} : undefined; // falls back to the hub's real default
// The served bundle's commit sha (stamped by the client build into
// dist/.pilot-built-sha). Read once at startup and carried in `hello` so a
// stale running client can detect that the server updated underneath it.
// Missing marker (dev, no build yet) → "" → clients skip the comparison.
const servedBuildSha = await Bun.file(
  join(config.clientDist, ".pilot-built-sha"),
)
  .text()
  .then((s) => s.trim())
  .catch(() => "");
const hub = new SessionHub(
  driver,
  (n) => {
    void push.sendToAll(n);
  },
  config.liveRefreshMs,
  serverId,
  config.dataDir,
  openInFileManager,
  servedBuildSha,
  config.deltaFlushMs,
);

const rawSend = (ws: ServerWebSocket<WsData>, msg: ServerMessage) => {
  sendJson(ws, msg, () =>
    log.warn(
      "ws message dropped (backpressure) — closing connection to force resync",
      { msgType: msg.type },
    ),
  );
};

function authenticate(ws: ServerWebSocket<WsData>, resume?: ResumeToken): void {
  ws.data.authed = true;
  // Mint one stable send closure for this connection and reuse it for both addClient
  // and every handleClient — the hub identifies the connection by this reference.
  const send = (m: ServerMessage) => rawSend(ws, m);
  ws.data.send = send;
  ws.data.unsub = hub.addClient(send, resume);
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
        // e2e/dev-bar hook: resets hub state + settings to the mock fixtures.
        // Mock-only — against the live driver it would wipe REAL settings and
        // session state behind nothing more than the app token.
        if (!mock)
          return new Response("debug reset is mock-driver-only", {
            status: 403,
          });
        hub.reset({
          bootstrap: url.searchParams.get("bootstrap") !== "0",
        });
        return Response.json({ ok: true }, { headers });
      }
      return new Response("not found", { status: 404 });
    }

    // Serve the built client in prod; in dev Vite serves it and proxies here.
    const asset = await serveStatic(url.pathname, req);
    if (asset) return asset;
    return new Response("pilot server — no client build (run `bun run dev`)", {
      status: 200,
    });
  },

  websocket: {
    // permessage-deflate: assistant markdown, fenced code, and full reconnect
    // seeds are highly compressible (measured 4-40x). NOTE: this option only
    // NEGOTIATES the extension — Bun compresses a frame only when the per-send
    // compress flag asks for it, which sendOrClose (ws-send.ts) does for frames
    // over COMPRESS_MIN_BYTES. Cost is per-connection deflate memory + CPU on
    // the Mac Mini — negligible for a single-user app.
    perMessageDeflate: true,
    // Explicit backpressure ceiling per socket (Bun default: 16MB). Past this,
    // Bun's send() returns 0 (dropped) and sendOrClose closes the connection
    // (1011) — the client reconnects and its hello.resume tail-replays exactly
    // the missed frames, so a stuck phone socket costs one cheap re-handshake,
    // never a silently desynced transcript. 4MB comfortably holds a large seed
    // + a stream burst over LTE while still bounding a truly wedged connection.
    // (Protocol v2 deliberately keeps close-on-drop over an in-band re-seed:
    // the recovery seed is the biggest message we send — pushing it into a
    // socket that just proved backpressured is the one way to make it worse.
    // closeOnBackpressureLimit stays false: sendOrClose owns the close, with a
    // log line and a deliberate close code.)
    backpressureLimit: 4 * 1024 * 1024,
    open() {
      // Attach happens on the client's hello — never here. The client always
      // sends one immediately on open (ws.svelte.ts onopen), and the hello may
      // carry a resume token that must be in hand BEFORE the seed goes out (the
      // whole point of resume is to not send that seed). With no token
      // configured, tokenOk() accepts the tokenless hello, so dev keeps working.
    },
    message(ws, raw) {
      const msg = parseClientMessage(
        typeof raw === "string" ? raw : raw.toString(),
      );
      if (!msg) return;
      if (!ws.data.authed) {
        if (msg.type === "hello" && tokenOk(msg.auth))
          authenticate(ws, msg.resume);
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
  driver: process.env.PILOT_DRIVER === "mock" ? "mock" : "polytoken",
  token: config.token ? "required" : "off",
  debug: config.debug,
});

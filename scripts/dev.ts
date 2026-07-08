// Brings up the whole dev stack with one command: the Rust WS server (PANTOKEN_PORT,
// default 8787) and the Vite client (VITE_PORT, default 5173, proxying /ws and
// /debug to PANTOKEN_SERVER). Used by `bun run dev` and by the Claude_Preview launch
// config so an agent can boot the app in one shot.
//
// ISOLATION NOTE: the live pantoken desktop app (desktop/Config.swift) exports its own
// PANTOKEN_PORT + PANTOKEN_DATA_DIR into the environment of every process it spawns — which
// includes agent sessions. So a preview/e2e launched from inside the running app inherits
// those. Auto-port mode (below) deliberately IGNORES the inherited PANTOKEN_PORT/PANTOKEN_DATA_DIR
// and self-isolates, so an agent instance never aims at — or fights the lock of — the live
// app or a concurrent session. Only an explicit, non-auto `bun run dev` honors them.
//
// Env vars:
//   PANTOKEN_PORT   — server listen port (default 8787; ignored in auto-port mode)
//   VITE_PORT    — Vite dev-server port (default 5173)
//   PANTOKEN_SERVER — WS backend URL that Vite proxies to (default http://localhost:8787)

import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

// Ask the OS for an unused TCP port (bind :0, read it back, release). Used on the auto-port
// paths (Claude_Preview's $PORT, e2e's PANTOKEN_AUTO_PORT) so parallel — or leaked — instances
// never fight over one hardcoded port; bare `bun run dev` still pins 8787 below.
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => res(port));
    });
  });
}

// Is something already listening on this port? A CONNECT probe, not a bind probe: on macOS
// Bun.serve (and Bun's node:net) will happily bind a port an orphan already holds
// (SO_REUSEADDR/REUSEPORT across 0.0.0.0 vs 127.0.0.1), so a bind test gives a false negative
// for exactly the orphan we're hunting — and you'd end up with TWO listeners the kernel
// load-balances between (fresh server + stale orphan). A successful TCP connect is
// unambiguous: someone's there.
function portInUse(port: number): Promise<boolean> {
  return Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: { data() {} },
  })
    .then((sock) => {
      sock.end();
      return true;
    })
    .catch(() => false);
}

// Vite's port: under Claude_Preview `autoPort` the harness assigns one and passes it as
// $PORT; otherwise honor VITE_PORT, else Vite's own default (5173).
const vitePort = process.env.PORT ?? process.env.VITE_PORT;

// Auto-port is requested when Claude_Preview passes $PORT (for Vite) or the e2e suite sets
// PANTOKEN_AUTO_PORT=1. Its whole point is an ISOLATED, collision-free instance.
const autoPort =
  process.env.PORT != null || process.env.PANTOKEN_AUTO_PORT === "1";

// Backend port. In auto-port mode, grab an OS-assigned FREE port and IGNORE any inherited
// PANTOKEN_PORT: the live desktop app exports its own into the shell (see ISOLATION NOTE), so
// honoring it would aim this preview/e2e instance at the LIVE backend (or a concurrent
// session's) instead of a fresh one — and a free port is also immune to leaked orphans
// squatting a fixed port. Outside auto-port (bare `bun run dev`) an explicit PANTOKEN_PORT
// wins, else the 8787 default.
const backendPort = autoPort
  ? String(await freePort())
  : (process.env.PANTOKEN_PORT ?? "8787");

// A freePort() result is guaranteed free; a pinned port (explicit/inherited PANTOKEN_PORT, or
// the 8787 default) might be held by an orphan or the live app — probe it so we fail loud
// rather than starting a second listener Vite then proxies to ambiguously. (Skipped in
// auto-port mode, where the port was just freshly reserved.)
const usedFreePort = autoPort;
if (!usedFreePort && (await portInUse(Number(backendPort)))) {
  console.error(
    `[dev] backend port ${backendPort} is already in use — likely an orphaned pantoken ` +
      `server from an interrupted run, or another dev/preview instance. Find + kill it:\n` +
      `        lsof -ti:${backendPort} | xargs kill`,
  );
  process.exit(1);
}

const SERVER = process.env.PANTOKEN_SERVER ?? `http://localhost:${backendPort}`;
// Bun-run Vite can hang proxy WebSocket upgrades; point the client at the backend
// socket directly while keeping Vite's HTTP proxy for /debug, /health, etc.
const wsUrl = new URL("/ws", SERVER);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

// Each dev/preview/e2e instance gets its OWN data dir, keyed by port. In auto-port mode we
// IGNORE any inherited PANTOKEN_DATA_DIR for the same reason as the port: the live app exports
// its data dir into the shell, and sharing it means fighting the running app (and other
// agent sessions) over the single PID lock — "data dir already locked". Keyed by the free
// port, concurrent previews / e2e runs / the live app never collide. Outside auto-port an
// explicit PANTOKEN_DATA_DIR still wins (else the same per-port default). The PID lock guards
// one data dir against two servers; production `server start` uses the default XDG dir.
const stateHome =
  process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
const dataDir =
  !autoPort && process.env.PANTOKEN_DATA_DIR
    ? process.env.PANTOKEN_DATA_DIR
    : join(stateHome, "pantoken-dev", backendPort);

const viteArgs = ["run", "dev"];
if (vitePort) viteArgs.push("--port", vitePort);

const backendEnv = {
  ...process.env,
  PANTOKEN_PORT: backendPort,
  PANTOKEN_DATA_DIR: dataDir,
  // In auto-port mode the instance must be tokenless (auth disabled), like every other
  // dev/preview/e2e instance. The live desktop app exports its own PANTOKEN_TOKEN into the
  // shell it spawns (same leak as PANTOKEN_PORT/PANTOKEN_DATA_DIR above); inheriting it would
  // enable the token gate here, so the tokenless /debug reset + /?dev load in e2e (and a
  // mock preview) hit the TokenGate instead of the app. Outside auto-port an explicit
  // PANTOKEN_TOKEN still wins, so a real `bun run dev` behind a token keeps it.
  ...(autoPort ? { PANTOKEN_TOKEN: undefined } : {}),
};

// Start the backend first and wait until it answers /health before launching Vite.
// Otherwise Vite (and thus the dev-server port) comes up while the WS backend is
// still booting — a tool like Claude_Preview returns as soon as the port listens,
// catching the client mid-reconnect-backoff with a stale "Offline" banner and an
// empty session list. Gating on /health makes the first WS connect succeed.
const server = Bun.spawn(["cargo", "run"], {
  cwd: "server-rs",
  env: backendEnv,
  stdout: "inherit",
  stderr: "inherit",
});

async function waitForHealth(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // backend not listening yet — retry until the deadline
    }
    await Bun.sleep(150);
  }
  console.warn(
    `[dev] ${base}/health not ready after ${timeoutMs}ms; starting Vite anyway`,
  );
}

await waitForHealth(SERVER);

const vite = Bun.spawn(["bun", ...viteArgs], {
  cwd: "client",
  env: {
    ...process.env,
    PANTOKEN_SERVER: SERVER,
    VITE_PANTOKEN_WS_URL: wsUrl.toString(),
  },
  stdout: "inherit",
  stderr: "inherit",
});

const procs = [server, vite];

let shuttingDown = false;
function shutdown(code: number): never {
  shuttingDown = true;
  for (const p of procs) p.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// Last-resort: kill children even on an uncaught throw / plain exit, so dev.ts never leaves a
// detached `bun --hot` server behind (that orphan is exactly what poisons the next e2e run).
process.on("exit", () => {
  for (const p of procs) p.kill();
});

// If either child exits on its own — a crash, or a port collision the preflight didn't catch —
// tear the whole stack down with a non-zero code instead of lingering as a half-running (and
// possibly stale) dev server.
void server.exited.then((c) => {
  if (!shuttingDown) {
    console.error(`[dev] backend exited (code ${c}) — shutting down`);
    shutdown(1);
  }
});
void vite.exited.then((c) => {
  if (!shuttingDown) {
    console.error(`[dev] vite exited (code ${c}) — shutting down`);
    shutdown(1);
  }
});

await Promise.all(procs.map((p) => p.exited));

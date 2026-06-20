// Brings up the whole dev stack with one command: the Bun WS server (PILOT_PORT,
// default 8787) and the Vite client (VITE_PORT, default 5173, proxying /ws and
// /debug to PILOT_SERVER). Used by `bun run dev` and by the Claude_Preview launch
// config so an agent can boot the app in one shot.
//
// Env vars:
//   PILOT_PORT   — server listen port (default 8787)
//   VITE_PORT    — Vite dev-server port (default 5173)
//   PILOT_SERVER — WS backend URL that Vite proxies to (default http://localhost:8787)

import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

// Ask the OS for an unused TCP port (bind :0, read it back, release). Used on the auto-port
// paths (Claude_Preview's $PORT, e2e's PILOT_AUTO_PORT) so parallel — or leaked — instances
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

// Backend port. An explicit PILOT_PORT always wins. Otherwise, when auto-port is requested —
// Claude_Preview passes $PORT; the e2e suite sets PILOT_AUTO_PORT=1 — grab an OS-assigned free
// port so the stack is collision-free across parallel worktrees AND immune to leaked orphans
// (a stale server squatting on a fixed port can never be silently proxied to). Bare
// `bun run dev` keeps the 8787 default.
const autoPort =
  process.env.PORT != null || process.env.PILOT_AUTO_PORT === "1";
const backendPort = process.env.PILOT_PORT
  ? process.env.PILOT_PORT
  : autoPort
    ? String(await freePort())
    : "8787";

// A freePort() result is guaranteed free; a pinned port (explicit PILOT_PORT, or the 8787
// default) might be held by an orphan — probe it so we fail loud rather than starting a
// second listener Vite then proxies to ambiguously. (Skip when we grabbed a free port.)
const usedFreePort = !process.env.PILOT_PORT && autoPort;
if (!usedFreePort && (await portInUse(Number(backendPort)))) {
  console.error(
    `[dev] backend port ${backendPort} is already in use — likely an orphaned pilot ` +
      `server from an interrupted run, or another dev/preview instance. Find + kill it:\n` +
      `        lsof -ti:${backendPort} | xargs kill`,
  );
  process.exit(1);
}

const SERVER = process.env.PILOT_SERVER ?? `http://localhost:${backendPort}`;
// Bun-run Vite can hang proxy WebSocket upgrades; point the client at the backend
// socket directly while keeping Vite's HTTP proxy for /debug, /health, etc.
const wsUrl = new URL("/ws", SERVER);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

// Each dev/preview/e2e instance gets its OWN data dir, keyed by port, unless
// PILOT_DATA_DIR is set explicitly. The server's PID lock guards one data dir against
// two servers (so two real servers can't corrupt the shared archive/push/VAPID state);
// without per-port dirs that lock would stop you running several pilot instances at once
// (preview-mock, preview-real, e2e, …), which would otherwise all contend for the
// default dir. The production server runs via `server start` on the default XDG dir, so
// the lock still protects that.
const stateHome =
  process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
const dataDir =
  process.env.PILOT_DATA_DIR ?? join(stateHome, "pilot-dev", backendPort);

const viteArgs = ["run", "dev"];
if (vitePort) viteArgs.push("--port", vitePort);

// Start the backend first and wait until it answers /health before launching Vite.
// Otherwise Vite (and thus the dev-server port) comes up while the WS backend is
// still booting — a tool like Claude_Preview returns as soon as the port listens,
// catching the client mid-reconnect-backoff with a stale "Offline" banner and an
// empty session list. Gating on /health makes the first WS connect succeed.
const server = Bun.spawn(["bun", "run", "--hot", "src/index.ts"], {
  cwd: "server",
  env: { ...process.env, PILOT_PORT: backendPort, PILOT_DATA_DIR: dataDir },
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
    PILOT_SERVER: SERVER,
    VITE_PILOT_WS_URL: wsUrl.toString(),
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

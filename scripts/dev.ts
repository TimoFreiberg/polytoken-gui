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

// Ask the OS for an unused TCP port (bind :0, read it back, release). Used only on the
// Claude_Preview auto-port path, so two worktree sessions don't fight over one hardcoded
// port; `bun run dev` and e2e still pin explicit ports below.
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

// Vite's port: under Claude_Preview `autoPort` the harness assigns one and passes it as
// $PORT; otherwise honor VITE_PORT, else Vite's own default (5173).
const vitePort = process.env.PORT ?? process.env.VITE_PORT;

// Backend port: an explicit PILOT_PORT always wins (e2e + real dev pin it). Otherwise,
// on the auto-port preview path ($PORT present) grab a free port too, so the whole stack
// is collision-free across parallel worktrees; bare `bun run dev` keeps the 8787 default.
const backendPort = process.env.PILOT_PORT
  ? process.env.PILOT_PORT
  : process.env.PORT
    ? String(await freePort())
    : "8787";

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

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(procs.map((p) => p.exited));

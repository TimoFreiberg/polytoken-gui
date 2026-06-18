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

const SERVER = process.env.PILOT_SERVER ?? "http://localhost:8787";

// Each dev/preview/e2e instance gets its OWN data dir, keyed by port, unless
// PILOT_DATA_DIR is set explicitly. The server's PID lock guards one data dir against
// two servers (so two real servers can't corrupt the shared archive/push/VAPID state);
// without per-port dirs that lock would stop you running several pilot instances at once
// (preview-mock 5273, preview-real, e2e, …), which would otherwise all contend for the
// default dir. The production server runs via `server start` on the default XDG dir, so
// the lock still protects that.
const PORT = process.env.PILOT_PORT ?? "8787";
const stateHome =
  process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
const dataDir =
  process.env.PILOT_DATA_DIR ?? join(stateHome, "pilot-dev", PORT);

const viteArgs = ["run", "dev"];
if (process.env.VITE_PORT) viteArgs.push("--port", process.env.VITE_PORT);

// Start the backend first and wait until it answers /health before launching Vite.
// Otherwise Vite (and thus the dev-server port) comes up while the WS backend is
// still booting — a tool like Claude_Preview returns as soon as the port listens,
// catching the client mid-reconnect-backoff with a stale "Offline" banner and an
// empty session list. Gating on /health makes the first WS connect succeed.
const server = Bun.spawn(["bun", "run", "--hot", "src/index.ts"], {
  cwd: "server",
  env: { ...process.env, PILOT_DATA_DIR: dataDir },
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

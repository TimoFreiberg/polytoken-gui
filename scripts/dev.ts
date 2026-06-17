// Brings up the whole dev stack with one command: the Bun WS server (PILOT_PORT,
// default 8787) and the Vite client (VITE_PORT, default 5173, proxying /ws and
// /debug to PILOT_SERVER). Used by `bun run dev` and by the Claude_Preview launch
// config so an agent can boot the app in one shot.
//
// Env vars:
//   PILOT_PORT   — server listen port (default 8787)
//   VITE_PORT    — Vite dev-server port (default 5173)
//   PILOT_SERVER — WS backend URL that Vite proxies to (default http://localhost:8787)

const viteArgs = ["run", "dev"];
if (process.env.VITE_PORT) viteArgs.push("--port", process.env.VITE_PORT);

const procs = [
  Bun.spawn(["bun", "run", "--hot", "src/index.ts"], {
    cwd: "server",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", ...viteArgs], {
    cwd: "client",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

function shutdown() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(procs.map((p) => p.exited));

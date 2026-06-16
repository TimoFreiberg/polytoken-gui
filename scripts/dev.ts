// Brings up the whole dev stack with one command: the Bun WS server (8787) and the
// Vite client (5173, which proxies /ws + /debug to the server). Used by `bun run dev`
// and by the Claude_Preview launch config so an agent can boot the app in one shot.

const procs = [
  Bun.spawn(["bun", "run", "--hot", "src/index.ts"], {
    cwd: "server",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "dev"], {
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

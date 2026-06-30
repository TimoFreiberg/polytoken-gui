// parity/down.ts — tear the harness down. Idempotent and SAFE: it only ever touches the
// ISOLATED registry + the dedicated tmux server + the recorded pilot pid.
//
// Order:
//   1. SIGTERM the pilot launcher we recorded (if alive AND it looks like ours). SIGTERM —
//      never SIGKILL — so the server's shutdown handler runs and gracefully /terminates its
//      warm daemons + releases their leases. (If the GUI was started via Claude_Preview,
//      stop it with preview_stop instead; this no-ops on a dead/foreign pid.)
//   2. /terminate any daemons still live in the ISOLATED registry (TUI-spawned, throwaway-
//      resume leftovers, or orphans). polytokenSessions() always scopes to --sessions-dir,
//      so this can NEVER reach a prod daemon.
//   3. kill the dedicated tmux server.
//   4. --purge: rm -rf PARITY_ROOT.

import { rmSync } from "node:fs";
import {
  paths,
  polytokenSessions,
  readRunEnv,
  TMUX_BIN,
  type Paths,
} from "./lib.ts";

/** Is `pid` alive and does its command line look like OUR pilot launcher (guards pid reuse)?
 *  Matches only the specific launcher/server entry points — NOT a bare `bun`, which would
 *  match any bun process (the agent harness, other dev servers) reusing a recycled pid. */
async function isOurPilot(pid: number): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["ps", "-p", String(pid), "-o", "command="],
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) return false; // not alive
  const cmd = (await new Response(proc.stdout).text()).trim();
  // The recorded pid is our launcher entry point: `bun run parity/launch.ts` (preview) or
  // `bun run parity/parity.ts up` (script path). Match those specifically — never bare bun.
  return /parity\/(launch|parity)\.ts/.test(cmd);
}

export async function down(
  opts: { purge?: boolean } = {},
  p: Paths = paths(),
): Promise<void> {
  // 1. graceful pilot shutdown
  const run = readRunEnv(p);
  if (run?.pilotPid) {
    if (await isOurPilot(run.pilotPid)) {
      try {
        process.kill(run.pilotPid, "SIGTERM");
        console.error(`[parity down] SIGTERM pilot pid ${run.pilotPid}`);
      } catch {
        /* already gone */
      }
      // Give the server's async shutdown a moment to /terminate its daemons.
      await Bun.sleep(1500);
    } else {
      console.error(
        `[parity down] recorded pid ${run.pilotPid} not ours/alive — skipping`,
      );
    }
  }

  // 2. terminate any stragglers in the isolated registry
  const live = await polytokenSessions(p);
  for (const s of live) {
    try {
      await fetch(`http://127.0.0.1:${s.port}/terminate`, { method: "POST" });
      console.error(`[parity down] /terminate ${s.sessionId} (:${s.port})`);
    } catch {
      /* daemon already gone */
    }
  }

  // 3. dedicated tmux server
  const tproc = Bun.spawn({
    cmd: [TMUX_BIN, "-L", p.tmuxSocket, "kill-server"],
    stdout: "ignore",
    stderr: "ignore",
  });
  await tproc.exited;

  // 4. purge
  if (opts.purge) {
    rmSync(p.root, { recursive: true, force: true });
    console.error(`[parity down] purged ${p.root}`);
  }
  console.error("[parity down] done");
}

if (import.meta.main) {
  await down({ purge: process.argv.includes("--purge") });
}

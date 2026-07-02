// parity/parity.ts — the ONE entry point the skill teaches.
//
//   bun parity/parity.ts doctor [--quick]
//   bun parity/parity.ts up                 # launch pilot→polytoken GUI (run backgrounded)
//   bun parity/parity.ts down [--purge]     # tear everything down
//   bun parity/parity.ts project <reset|path|ensure>
//   bun parity/parity.ts tui <new|attach|continue|prompt|type|keys|capture|detach|end|ls|kill> …
//   bun parity/parity.ts oracle <daemon|tui|gui> [id]
//   bun parity/parity.ts assert <session-id> <needle>
//
// See .claude/skills/parity/SKILL.md for the runbook.

import { down } from "./down.ts";
import { preflight } from "./doctor.ts";
import { launch } from "./launch.ts";
import {
  commandOnPath,
  daemonHistoryContains,
  daemonHistoryText,
  paths,
  POLYTOKEN_BIN,
  TMUX_BIN,
} from "./lib.ts";
import { ensureProject, resetProject } from "./project.ts";
import { tuiCommand } from "./tui.ts";

const [cmd, ...rest] = process.argv.slice(2);
const p = paths();

async function main(): Promise<number> {
  switch (cmd) {
    case "doctor": {
      const { ok, checks } = await preflight({
        promptCheck: !rest.includes("--quick"),
      });
      for (const c of checks)
        console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
      console.log(
        `\n${ok ? "PASS" : "FAIL"} · root=${p.root} · model=${p.model.label} · config=${
          p.generateConfig
            ? `${p.xdgConfig} (generated)`
            : `${p.xdgConfig} (external)`
        }`,
      );
      return ok ? 0 : 1;
    }

    case "up": {
      // Foreground/blocking. The agent runs this with run_in_background (Bash tool) or via
      // the Claude_Preview `pilot-parity` config; `parity down` SIGTERMs the recorded pid.
      // The GUI server boots WITHOUT a provider key (daemons spawn lazily on session-open),
      // so we DON'T gate launch on the key/model check — we just warn. Run `parity doctor`
      // for the full model round-trip before driving sessions.
      await ensureProject(p); // ensures the isolated env + generated config + project
      if (!(await commandOnPath(POLYTOKEN_BIN))) {
        console.error(
          `[parity up] polytoken not on PATH (${POLYTOKEN_BIN}) — the GUI would boot but no ` +
            `session could spawn a daemon. Install polytoken or set PILOT_POLYTOKEN_BIN.`,
        );
        return 1;
      }
      const spec = p.model;
      if (p.generateConfig && !process.env[spec.keyEnv]?.trim()) {
        console.error(
          `[parity up] WARNING: $${spec.keyEnv} unset — the GUI boots, but sessions can't ` +
            `run until it's set (model ${spec.label}). Run \`parity doctor\` to verify.`,
        );
      }
      await launch(p);
      return 0;
    }

    case "down":
      await down({ purge: rest.includes("--purge") }, p);
      return 0;

    case "project": {
      const action = rest[0] ?? "ensure";
      if (action === "reset") console.log(await resetProject(p));
      else if (action === "path") console.log(p.project);
      else console.log(await ensureProject(p));
      return 0;
    }

    case "tui":
      await tuiCommand(rest, p);
      return 0;

    case "oracle": {
      const [which, id] = rest;
      if (which === "daemon") {
        if (!id) throw new Error("usage: oracle daemon <session-id>");
        process.stdout.write(await daemonHistoryText(id, p));
        process.stdout.write("\n");
      } else if (which === "tui") {
        await tuiCommand(["capture"], p);
      } else if (which === "gui") {
        console.log(
          "GUI oracle is the rendered DOM — read it from the browser via preview_snapshot " +
            "(Claude_Preview) or Playwright textContent. /debug/state does NOT carry the " +
            "driven session (it returns only the landing default).",
        );
      } else {
        throw new Error("usage: oracle <daemon|tui|gui> [id]");
      }
      return 0;
    }

    case "assert": {
      const [id, needle] = rest;
      if (!id || !needle)
        throw new Error("usage: assert <session-id> <needle>");
      // Ground truth: the daemon history (the authoritative result). Read live if the
      // session is up, else via a throwaway resume daemon.
      const inDaemon = await daemonHistoryContains(id, needle, p);
      // Best-effort TUI projection (only meaningful when the TUI is the live client).
      let tuiHas: boolean | null = null;
      try {
        const cap = await captureTui(p);
        if (cap != null) tuiHas = cap.includes(needle);
      } catch {
        tuiHas = null;
      }
      console.log(
        `  daemon (ground truth): ${inDaemon ? "✓ contains" : "✗ MISSING"} "${needle}"`,
      );
      console.log(
        `  tui pane:              ${
          tuiHas == null
            ? "— (no live TUI pane)"
            : tuiHas
              ? "✓ contains"
              : "✗ MISSING"
        }`,
      );
      console.log(
        "  gui:                   — check separately via preview_snapshot (DOM oracle)",
      );
      return inDaemon ? 0 : 1;
    }

    default:
      console.error(
        "usage: parity <doctor|up|down|project|tui|oracle|assert> …\n" +
          "  see .claude/skills/parity/SKILL.md",
      );
      return 1;
  }
}

/** Capture the TUI pane, or null if there's no live parity tmux session. */
async function captureTui(pp = p): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: [TMUX_BIN, "-L", pp.tmuxSocket, "capture-pane", "-p", "-t", "parity"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) return null;
  return new Response(proc.stdout).text();
}

process.exit(
  await main().catch((e) => {
    console.error(`[parity] ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }),
);

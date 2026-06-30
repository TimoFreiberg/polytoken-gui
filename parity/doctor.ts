// parity/doctor.ts — preflight. Fails LOUD before the harness builds on a broken base.
//
// The last check (a real prompt round-trip) is the one that catches the precondition
// that WILL bite: the generated config pins a cheap model whose provider key comes from an
// env var (e.g. $DEEPSEEK_API_KEY for deepseek-v4-flash). If unset, the WHOLE config fails
// to load — no model runs. We pre-check the chosen model's key, then run `polytoken exec`
// with the isolation env exported (so it tests the SAME config+sessions the harness uses),
// surfacing the exact remediation on failure.

import { ensureProject } from "./project.ts";
import {
  commandOnPath as onPath,
  ensureEnv,
  isolationEnv,
  paths,
  POLYTOKEN_BIN,
  TMUX_BIN,
  type Paths,
} from "./lib.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Run the full preflight. Returns checks + overall ok. Does NOT exit (the CLI wrapper does). */
export async function preflight(
  opts: { promptCheck?: boolean } = {},
  p: Paths = paths(),
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const promptCheck =
    opts.promptCheck ?? process.env.PARITY_SKIP_PROMPT_CHECK !== "1";

  // 1. tmux present
  checks.push({
    name: "tmux on PATH",
    ok: await onPath(TMUX_BIN),
    detail: TMUX_BIN,
  });

  // 2. polytoken present
  const hasPoly = await onPath(POLYTOKEN_BIN);
  checks.push({
    name: "polytoken on PATH",
    ok: hasPoly,
    detail: POLYTOKEN_BIN,
  });

  // 3. PARITY_ROOT writable + test project + generated config present
  let projectOk = false;
  let projectDetail = p.project;
  try {
    ensureEnv(p); // writes the cheap-model config.yaml if we own the config dir
    await ensureProject(p);
    projectOk = true;
  } catch (e) {
    projectDetail = `${p.project} — ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({
    name: "test project + config ready",
    ok: projectOk,
    detail: projectDetail,
  });

  // 4. the chosen model pair's provider key is set (the generated config references it)
  const spec = p.model;
  const keySet = !!process.env[spec.keyEnv]?.trim();
  checks.push({
    name: `provider key ($${spec.keyEnv}) set`,
    ok: keySet || !p.generateConfig, // an external config dir manages its own auth
    detail: p.generateConfig
      ? keySet
        ? `${spec.label} (full ${spec.full}) → $${spec.keyEnv} present`
        : `${spec.label} needs $${spec.keyEnv} — export it, or set PILOT_PARITY_MODEL/` +
          `PILOT_PARITY_CONFIG_DIR`
      : `using external config ($PILOT_PARITY_CONFIG_DIR) — auth is its own concern`,
  });

  // 5. real prompt round-trips (the auth/config-load check)
  if (!hasPoly) {
    checks.push({
      name: "model usable (polytoken exec)",
      ok: false,
      detail: "skipped — polytoken not on PATH",
    });
  } else if (!promptCheck) {
    const why =
      process.env.PARITY_SKIP_PROMPT_CHECK === "1"
        ? "PARITY_SKIP_PROMPT_CHECK=1"
        : "--quick";
    checks.push({
      name: "model usable (polytoken exec)",
      ok: true,
      detail: `skipped (${why}) — run \`parity doctor\` (no --quick) for the real check`,
    });
  } else {
    const r = await execProbe(p);
    checks.push({
      name: "model usable (polytoken exec)",
      ok: r.ok,
      detail: r.detail,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/** Spawn `polytoken exec` with the isolation env and confirm it produces output. A config
 *  that references an unset key fails here at load (exit ≠ 0), which is exactly the signal. */
async function execProbe(p: Paths): Promise<{ ok: boolean; detail: string }> {
  const proc = Bun.spawn({
    cmd: [POLYTOKEN_BIN, "exec", `Reply with exactly: PARITY-PREFLIGHT-OK`],
    // CRITICAL: export the isolation env so the probe tests the harness's config+sessions,
    // not prod. exec accepts no --sessions-dir; XDG_DATA_HOME redirects it.
    env: { ...process.env, ...isolationEnv(p) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* gone */
    }
  }, 120_000);
  const code = await proc.exited;
  clearTimeout(timeout);
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  if (code !== 0) {
    const spec = p.model;
    const hint = /env var \$\w+ referenced/.test(stderr)
      ? `\n      → provider key unset: export $${spec.keyEnv} (for ${spec.label}), switch with ` +
        `PILOT_PARITY_MODEL, or point $PILOT_PARITY_CONFIG_DIR at a working config.`
      : "";
    return {
      ok: false,
      detail: `exit ${code}: ${(stderr || stdout).slice(0, 300)}${hint}`,
    };
  }
  if (!stdout) {
    return { ok: false, detail: "exec exited 0 but produced no output" };
  }
  const sawMarker = stdout.includes("PARITY-PREFLIGHT-OK");
  return {
    ok: true,
    detail: sawMarker
      ? "model replied with the marker"
      : `model ran (no exact marker, fine): "${stdout.slice(0, 80)}"`,
  };
}

// CLI: `bun parity/doctor.ts [--quick]`
if (import.meta.main) {
  const quick = process.argv.includes("--quick");
  const p = paths();
  const { ok, checks } = await preflight({ promptCheck: !quick }, p);
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }
  console.log(
    `\n${ok ? "PASS" : "FAIL"} · root=${p.root} · model=${p.model.label} (full ${p.model.full}) · config=${
      p.generateConfig
        ? `${p.xdgConfig} (generated)`
        : `${p.xdgConfig} (external)`
    }`,
  );
  process.exit(ok ? 0 : 1);
}

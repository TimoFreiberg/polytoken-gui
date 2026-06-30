// parity/lib.ts — shared core for the GUI ⇄ TUI parity harness.
//
// See docs/PARITY-TESTING.md for the architecture and docs/PLAN-parity-testing.md for
// the design + the adversarial-review trail. The load-bearing facts this module encodes:
//
//  - polytoken writes THREE XDG roots: sessions+logs+tui_state under $XDG_DATA_HOME,
//    config+auth under $XDG_CONFIG_HOME, provider-catalog cache under $XDG_CACHE_HOME.
//    `--sessions-dir` redirects ONLY sessions/, so isolation is via the XDG env vars,
//    exported into every harness-spawned process (pilot, tmux panes, daemons).
//  - The whole footprint lives under one PARITY_ROOT so teardown is one rm -rf and it
//    provably can't touch prod state (the live `~/.local/share/polytoken/sessions`).
//  - SAFETY: a bare `polytoken sessions` (no --sessions-dir / no isolated XDG_DATA_HOME)
//    lists PROD daemons — terminating those would kill the user's real sessions. Every
//    call here goes through `polytokenSessions()`, which sets BOTH the isolated env and
//    the --sessions-dir flag. Never shell out to `polytoken sessions` directly.

import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const POLYTOKEN_BIN = process.env.PILOT_POLYTOKEN_BIN ?? "polytoken";
export const TMUX_BIN = process.env.PILOT_PARITY_TMUX_BIN ?? "tmux";

/** Marker prefix for deterministic parity prompts (`Reply with exactly: PARITY-OK-<n>`),
 *  so an assert needle survives a non-deterministic model. */
export const MARKER = "PARITY-OK";

/** The single isolation root. Everything the harness writes lives under here, so the
 *  whole harness is one `rm -rf` from gone. Override with $PILOT_PARITY_ROOT. */
export function parityRoot(): string {
  const explicit = process.env.PILOT_PARITY_ROOT?.trim();
  if (explicit) return explicit;
  const stateHome =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "pilot-parity");
}

// --- the model pair the generated test config pins ---
//
// polytoken's config has TWO default slots with TIER constraints: `defaults.full` must be a
// Full-tier model (the agent's main model) and `defaults.mini` a Mini-tier model (cheap
// background tasks). A model like deepseek-v4-flash is Mini-only, so it CANNOT be `full` —
// the daemon rejects the config ("references X, which is Mini, not Full"). So a preset is a
// matched (full, mini) PAIR within ONE provider (so only one key is needed). Verified valid
// via `polytoken config validate`.
//
// $PILOT_PARITY_MODEL selects a preset; $PILOT_PARITY_FULL + $PILOT_PARITY_MINI (both, same
// provider) override with an explicit pair; $PILOT_PARITY_CONFIG_DIR overrides wholesale.

/** A preset name selecting a (full, mini) model pair. */
export type ParityModel = "deepseek" | "umans";

export interface ModelSpec {
  /** Display label (the preset name, or "custom" for an explicit FULL/MINI override). */
  label: string;
  /** Provider block name (== catalog name; catalog providers resolve model ids dynamically,
   *  so no `models:` section is needed — mirrors the real config). */
  provider: string;
  /** `provider/model` for `defaults.full` — must be a Full-tier model (the agent's model). */
  full: string;
  /** `provider/model` for `defaults.mini` — a Mini-tier model (cheap background tasks). */
  mini: string;
  /** The env var the provider's static_key references — the ONLY key this config needs. */
  keyEnv: string;
}

/** Matched (full, mini) pairs, each within one provider so a single key suffices. */
const PRESETS: Record<ParityModel, ModelSpec> = {
  // Default: deepseek (owner's reliability pick). Full=v4-pro, Mini=v4-flash. Metered but
  // cheap. Both tiers validated via `polytoken config validate`.
  deepseek: {
    label: "deepseek",
    provider: "deepseek",
    full: "deepseek/deepseek-v4-pro",
    mini: "deepseek/deepseek-v4-flash",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  // umans: flat-rate / unlimited (cost-free, just slower TTFT). Mirrors the real config's
  // default_model / default_small_model.
  umans: {
    label: "umans",
    provider: "umans",
    full: "umans/umans-glm-5.2",
    mini: "umans/umans-flash",
    keyEnv: "UMANS_API_KEY",
  },
};

/** The env var each known provider's static_key references (for an explicit FULL/MINI pair). */
const PROVIDER_KEYS: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  umans: "UMANS_API_KEY",
};

/** Resolve the active model pair: an explicit `PILOT_PARITY_FULL`+`PILOT_PARITY_MINI` pair
 *  (same provider) if both are set, else the `PILOT_PARITY_MODEL` preset (default deepseek). */
export function modelSpec(): ModelSpec {
  const full = process.env.PILOT_PARITY_FULL?.trim();
  const mini = process.env.PILOT_PARITY_MINI?.trim();
  if (full && mini) {
    const provider = full.split("/")[0] ?? "";
    return {
      label: "custom",
      provider,
      full,
      mini,
      keyEnv: PROVIDER_KEYS[provider] ?? `${provider.toUpperCase()}_API_KEY`,
    };
  }
  const name = process.env.PILOT_PARITY_MODEL?.trim() || "deepseek";
  const preset = PRESETS[name as ParityModel];
  if (!preset) {
    throw new Error(
      `PILOT_PARITY_MODEL="${name}" unknown — presets: ${Object.keys(PRESETS).join(", ")} ` +
        `(or set both PILOT_PARITY_FULL + PILOT_PARITY_MINI to an explicit same-provider pair)`,
    );
  }
  return preset;
}

/** Render a minimal, self-contained polytoken config.yaml pinning the (full, mini) pair and
 *  declaring ONLY that provider — so the daemon loads with just one key set. Auth is an
 *  env-ref (the owner has the keys in their env), matching the real config. */
export function renderConfig(spec: ModelSpec = modelSpec()): string {
  return `# Generated by the parity harness (parity/lib.ts) — pins a cheap (full, mini) pair so
# automated GUI⇄TUI test runs don't burn the prod default. Swap via PILOT_PARITY_MODEL
# (deepseek|umans) or PILOT_PARITY_FULL+PILOT_PARITY_MINI, or point $PILOT_PARITY_CONFIG_DIR
# at your own config to override wholesale.
version: 2
defaults:
  full: ${spec.full}
  mini: ${spec.mini}
providers:
  ${spec.provider}:
    kind:
      type: catalog
      name: ${spec.provider}
    auth:
      type: static_key
      key: \${${spec.keyEnv}}
# Unattended-friendly for automated runs (mirrors the real config); switch the runtime
# permission monitor (GUI/TUI both expose it) to exercise approval popups.
default_permission_matcher: bypass_plus
`;
}

export interface Paths {
  root: string;
  /** The test project — the session cwd shared by both surfaces. */
  project: string;
  /** → XDG_DATA_HOME: polytoken sessions/, logs/, tui_state.json. */
  xdgData: string;
  /** → XDG_CACHE_HOME: provider-catalogs (regenerable). */
  xdgCache: string;
  /** → XDG_CONFIG_HOME. Defaults to an ISOLATED dir under the root holding a generated,
   *  prefilled config.yaml that pins a cheap (full, mini) model pair (see modelSpec/renderConfig).
   *  Override with $PILOT_PARITY_CONFIG_DIR to point at a hand-maintained config (e.g. the
   *  real ~/.config) — then nothing is generated. */
  xdgConfig: string;
  /** True when xdgConfig is the harness-owned dir we generate config.yaml into (no override). */
  generateConfig: boolean;
  /** The resolved (full, mini) model pair the generated config pins. */
  model: ModelSpec;
  /** The polytoken sessions registry (under xdgData). */
  sessionsDir: string;
  /** The global config dir a spawned daemon resolves to (real or isolated). Used for
   *  the resume-daemon oracle's --global-config-dir. */
  globalConfigDir: string;
  /** pilot's PILOT_DATA_DIR (push keys, archive index) — under the root for clean teardown. */
  pilotData: string;
  /** run/ — per-launch tracking (pid, ports, GUI_URL). */
  runDir: string;
  envFile: string;
  /** Dedicated tmux server socket name (`tmux -L <name>`) — never the user's default. */
  tmuxSocket: string;
}

/** djb2 — a tiny stable hash so two PARITY_ROOTs get two tmux sockets without crypto. */
function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function paths(root = parityRoot()): Paths {
  const xdgData = join(root, "xdg-data");
  // Default: an isolated config dir under the root (we generate config.yaml into it).
  // Override: $PILOT_PARITY_CONFIG_DIR points at a hand-maintained config dir (no generate).
  const override = process.env.PILOT_PARITY_CONFIG_DIR?.trim() || null;
  const xdgConfig = override ?? join(root, "xdg-config");
  return {
    root,
    project: join(root, "project"),
    xdgData,
    xdgCache: join(root, "xdg-cache"),
    xdgConfig,
    generateConfig: !override,
    model: modelSpec(),
    sessionsDir: join(xdgData, "polytoken", "sessions"),
    // The global config dir polytoken resolves to: $XDG_CONFIG_HOME/polytoken (mirrors
    // daemon-client.ts defaultGlobalConfigDir()). Used for the resume-daemon oracle's
    // --global-config-dir; identical to what pilot derives from its inherited XDG_CONFIG_HOME.
    globalConfigDir: join(xdgConfig, "polytoken"),
    pilotData: join(root, "pilot-data"),
    runDir: join(root, "run"),
    envFile: join(root, "run", "env.json"),
    tmuxSocket: `pilot-parity-${stableHash(root)}`,
  };
}

/** The env every harness-spawned process must carry so its polytoken footprint lands
 *  under PARITY_ROOT. Isolates ALL THREE XDG roots: data (sessions/logs/tui_state),
 *  cache (catalogs), and config (the generated cheap-model config.yaml). */
export function isolationEnv(p: Paths = paths()): Record<string, string> {
  return {
    XDG_DATA_HOME: p.xdgData,
    XDG_CACHE_HOME: p.xdgCache,
    XDG_CONFIG_HOME: p.xdgConfig,
  };
}

/** Create every dir the harness writes to AND write the generated config.yaml if we own
 *  the config dir and it isn't there yet (idempotent — never clobbers an existing file,
 *  so an operator can hand-edit it). */
export function ensureEnv(p: Paths = paths()): void {
  for (const d of [
    p.root,
    p.xdgData,
    p.xdgCache,
    p.xdgConfig,
    join(p.xdgConfig, "polytoken"),
    p.sessionsDir,
    p.pilotData,
    p.runDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }
  if (p.generateConfig) {
    const cfg = join(p.xdgConfig, "polytoken", "config.yaml");
    if (!existsSync(cfg)) writeFileSync(cfg, renderConfig(p.model));
  }
}

/** Ask the OS for an unused TCP port (bind :0, read it back, release). */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => res(port));
    });
  });
}

/** Is `bin` resolvable on PATH? (`command -v`, exit 0 = found.) */
export async function commandOnPath(bin: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["sh", "-c", `command -v ${bin}`],
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

// --- run-env tracking (what `up` launched; what `down` tears down) ---

export interface RunEnv {
  pilotPid?: number;
  backendPort?: number;
  vitePort?: number;
  guiUrl?: string;
  startedAt?: string;
}

export function writeRunEnv(env: RunEnv, p: Paths = paths()): void {
  ensureEnv(p);
  writeFileSync(p.envFile, JSON.stringify(env, null, 2));
}

export function readRunEnv(p: Paths = paths()): RunEnv | null {
  if (!existsSync(p.envFile)) return null;
  try {
    return JSON.parse(readFileSync(p.envFile, "utf8")) as RunEnv;
  } catch {
    return null;
  }
}

// --- polytoken session registry (always isolated) ---

export interface LiveSession {
  sessionId: string;
  port: number;
  pid: number;
  projectPath: string;
}

interface StartupJson {
  state?: string;
  pid?: number;
  port?: number;
  message?: string;
}

function readStartupJson(sessionId: string, p: Paths): StartupJson | null {
  const file = join(p.sessionsDir, sessionId, "startup.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StartupJson;
  } catch {
    return null;
  }
}

/** Read a session's on-disk session.json (for project_path / created_at). null if absent. */
export function readSessionJson(
  sessionId: string,
  p: Paths = paths(),
): { project_path?: string; created_at?: string } | null {
  const file = join(p.sessionsDir, sessionId, "session.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** A polytoken session id, e.g. `04trdx-dance` — a short alphanumeric segment, a dash, then a
 *  word. Used to distinguish a data row's first token from the header (`SESSION_ID`) and the
 *  empty-list sentinel (`no live sessions`), so the parser is correct standalone (not only
 *  because a downstream startup.json gate happens to filter phantoms). */
const SESSION_ID_RE = /^[0-9a-z]+-[0-9a-z][0-9a-z-]*$/i;

/** Extract live session IDs from `polytoken sessions` output. We take ONLY the first
 *  whitespace token of each row — the SESSION_ID column, which is column 1 in every layout —
 *  and keep it only if it's session-id-shaped. So this is robust to the table's other columns
 *  changing (PORT present or not, absolute vs. relative timestamps) AND to the header /
 *  `no live sessions` sentinel. Port/pid are read from startup.json instead. */
export function parseLiveSessionIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const raw of stdout.split("\n")) {
    const id = raw.trim().split(/\s+/)[0];
    if (id && SESSION_ID_RE.test(id)) ids.push(id);
  }
  return ids;
}

/** SAFETY-CRITICAL: the ONLY way to list polytoken sessions in this harness. Always sets
 *  the isolated XDG_DATA_HOME *and* --sessions-dir, so it can never see — and a caller can
 *  never `/terminate` — a prod daemon. Do not call `polytoken sessions` any other way.
 *
 *  `polytoken sessions` is the authority on WHICH sessions are live (it stale-cleans dead
 *  entries); each live session's bound PORT is read from its own startup.json (the daemon's
 *  record of the port it bound), NOT from the table — so a column-format change can't break
 *  teardown/oracle. A listed session whose startup.json isn't ready (no port yet) is omitted. */
export async function polytokenSessions(
  p: Paths = paths(),
): Promise<LiveSession[]> {
  const proc = Bun.spawn({
    cmd: [POLYTOKEN_BIN, "sessions", "--sessions-dir", p.sessionsDir],
    env: { ...process.env, ...isolationEnv(p) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const out: LiveSession[] = [];
  for (const id of parseLiveSessionIds(stdout)) {
    const su = readStartupJson(id, p);
    if (su?.state !== "ready" || typeof su.port !== "number") continue;
    out.push({
      sessionId: id,
      port: su.port,
      pid: su.pid ?? 0,
      projectPath: readSessionJson(id, p)?.project_path ?? "",
    });
  }
  return out;
}

// --- the daemon oracle (ground truth: GET /history) ---

/** Fetch a daemon's full history snapshot (a big-limit GET /history). */
export async function daemonHistory(port: number): Promise<unknown> {
  const res = await fetch(
    `http://127.0.0.1:${port}/history?offset=0&limit=100000`,
  );
  if (!res.ok) throw new Error(`GET /history → ${res.status}`);
  return res.json();
}

/**
 * Run `fn(port)` against a daemon serving `sessionId`'s history, then clean up.
 *
 * If a daemon is already LIVE for the session (e.g. pilot has it warm, or the TUI is
 * attached), use its running port read-only — do NOT spawn a second daemon (that
 * violates one-daemon-per-session and aliases the registry; it is NOT merely a lease
 * 409). Otherwise the session is cold: spawn a throwaway `daemon --resume`, wait for its
 * startup.json, run fn, then /terminate it.
 */
export async function withDaemonHistory<T>(
  sessionId: string,
  fn: (port: number) => Promise<T>,
  p: Paths = paths(),
): Promise<T> {
  const live = (await polytokenSessions(p)).find(
    (s) => s.sessionId === sessionId,
  );
  if (live) return fn(live.port);

  // Cold: spawn a throwaway resume daemon. Needs cwd + sessions-dir + global-config-dir.
  ensureEnv(p); // guarantee the generated config exists before the daemon loads it
  const meta = readSessionJson(sessionId, p);
  const cwd = meta?.project_path || p.project;
  const proc = Bun.spawn({
    cmd: [
      POLYTOKEN_BIN,
      "daemon",
      "--project-dir",
      cwd,
      "--session-id",
      sessionId,
      "--resume",
      "--sessions-dir",
      p.sessionsDir,
      "--global-config-dir",
      p.globalConfigDir,
    ],
    env: { ...process.env, ...isolationEnv(p) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let port: number | null = null;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const su = readStartupJson(sessionId, p);
      if (
        su?.state === "ready" &&
        su.pid === proc.pid &&
        typeof su.port === "number"
      ) {
        port = su.port;
        break;
      }
      if (su?.state === "failed" && su.pid === proc.pid) {
        throw new Error(`resume daemon failed: ${su.message ?? "no message"}`);
      }
      await Bun.sleep(100);
    }
    if (port == null) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(
        `resume daemon for ${sessionId} not ready in 20s${err ? `\nstderr: ${err.slice(0, 400)}` : ""}`,
      );
    }
    return await fn(port);
  } finally {
    // Graceful terminate only if we learned the port; otherwise the kill() below is the
    // sole cleanup (a never-ready daemon has no port to POST to — don't fetch :0).
    if (port != null) {
      await fetch(`http://127.0.0.1:${port}/terminate`, {
        method: "POST",
      }).catch(() => {});
    }
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Does the session's daemon history contain `needle`? Robust to item-shape drift —
 *  stringifies the whole snapshot and substring-matches. */
export async function daemonHistoryContains(
  sessionId: string,
  needle: string,
  p: Paths = paths(),
): Promise<boolean> {
  return withDaemonHistory(
    sessionId,
    async (port) => JSON.stringify(await daemonHistory(port)).includes(needle),
    p,
  );
}

/** Best-effort readable text projection of a session's history (for `parity oracle daemon`).
 *  Collects string leaves under common text keys; falls back to the raw JSON. */
export async function daemonHistoryText(
  sessionId: string,
  p: Paths = paths(),
): Promise<string> {
  return withDaemonHistory(
    sessionId,
    async (port) => {
      const snap = (await daemonHistory(port)) as { items?: unknown[] };
      const texts: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") {
          if (v.trim()) texts.push(v);
        } else if (Array.isArray(v)) {
          for (const x of v) walk(x);
        } else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            // Skip obviously non-display keys to keep the projection readable.
            if (k === "signature" || k === "id" || k.endsWith("_id")) continue;
            walk(x);
          }
        }
      };
      walk(snap.items ?? snap);
      return texts.join("\n");
    },
    p,
  );
}

#!/usr/bin/env bun
// capture-daemon-corpus.ts — record a golden SSE corpus from a REAL polytoken daemon.
//
// This is the deliberate, separate "live capture" step behind the golden corpus
// (server-rs/tests/corpus/<version>/). The committed seed fixtures ship
// pre-canonicalized and the Rust loader (server-rs/pantoken-server/tests/corpus.rs)
// validates their shape; THIS script is how you (re-)ground them against what the
// daemon actually emits — on first capture and on every daemon bump (the drift
// canary: re-capture, diff, adopt).
//
// ─── SAFETY ─────────────────────────────────────────────────────────────────
// Capture spawns a THROWAWAY, fully-ISOLATED daemon via the parity harness's
// isolation env (isolationEnv: XDG_{DATA,CONFIG,CACHE}_HOME + --sessions-dir all
// under PARITY_ROOT). It can never see, drive, or /terminate a prod daemon or your
// real ~/.local/share/polytoken/sessions. It claims a fresh session's TUI lease,
// drives it, records, then /terminate + kill.
//
// ─── COST ───────────────────────────────────────────────────────────────────
// Driving a scenario runs a REAL model turn through your configured provider —
// it spends money. That's why this is a manual, opt-in tool, not part of `bun test`.
//
// ─── USAGE ──────────────────────────────────────────────────────────────────
//   bun run scripts/capture-daemon-corpus.ts <scenario> [--write]
//   bun run scripts/capture-daemon-corpus.ts streaming-turn --write
//     <scenario>  one of the registered scenarios (see SCENARIOS below)
//     --write     write the canonicalized JSON to the corpus dir; omit for a dry-run
//                 that prints to stdout so you can eyeball before committing.
//
// ─── AUTOMATED vs MANUAL ─────────────────────────────────────────────────────
// `streaming-turn` is fully automated (prompt → collect until message_complete).
// The interactive scenarios (tool-call-approval, ask-user-question, abort,
// queue-while-in-flight) need mid-turn driving (approve a permission, answer a
// question, abort, prompt-while-busy). They're registered as stubs with the exact
// driver steps to fill in; capturing them means scripting the mid-turn POSTs
// against the recorded request/response shapes in the seed fixtures. Do that when
// you run the live capture; until then the hand-authored seeds stand.
//
// ─── DETERMINISM ─────────────────────────────────────────────────────────────
// Real output carries non-deterministic session/prompt ids and wall-clock
// timestamps, and /state machine-specific data. `canonicalizeScenario` rewrites
// them to stable placeholders, MIRRORING server-rs/pantoken-server/tests/corpus.rs
// EXACTLY (session_id→SESSION, UUID prompt ids→PROMPT_N in first-seen order with
// HTTP walked before SSE, emitted_at/timestamp→monotonic epoch, /state leak fields
// → type-preserving placeholders). KNOWN LIMITATION (shared with the Rust loader):
// wall-clock timestamps INSIDE HTTP response bodies (e.g. state `updated_at`) are
// NOT rewritten — the seed HTTP bodies carry none. If a real capture's HTTP bodies
// carry timestamps, extend canonicalizeValue (here AND in corpus.rs together) to
// null/normalize them before freezing, or the corpus will be non-deterministic.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  POLYTOKEN_BIN,
  type Paths,
  ensureEnv,
  isolationEnv,
  paths,
  renderConfig,
} from "../parity/lib";

/** Read a fresh daemon's startup.json (state/pid/port). Inlined from parity/lib.ts
 *  — its readStartupJson is not exported; the on-disk path layout is stable. Only
 *  the SAFETY-critical isolationEnv is imported (never duplicate that). */
function readStartupJson(
  sessionId: string,
  p: Paths,
): { state?: string; pid?: number; port?: number; message?: string } | null {
  const file = join(p.sessionsDir, sessionId, "startup.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const CORPUS_VERSION = "0.4.0-unstable.7";
const CORPUS_DIR = join(
  import.meta.dir,
  "..",
  "server-rs",
  "tests",
  "corpus",
  CORPUS_VERSION,
);

// ─── Canonicalization (mirrors server-rs/pantoken-server/tests/corpus.rs) ────────

const isPromptPlaceholder = (s: string) => /^PROMPT_\d+$/.test(s);
const isSessionPlaceholder = (s: string) => s === "SESSION";
const isMonotonicEpoch = (s: string) =>
  s.length === 24 && s.startsWith("1970-01-01T") && s.endsWith(".000Z");

class CanonState {
  private sessions = new Map<string, string>();
  private prompts = new Map<string, string>();
  private nextPrompt = 0;

  canonSession(raw: string): string {
    if (isSessionPlaceholder(raw)) return raw;
    // Single-session corpus: every real session id collapses to one placeholder.
    if (!this.sessions.has(raw)) this.sessions.set(raw, "SESSION");
    return this.sessions.get(raw)!;
  }

  canonPrompt(raw: string): string {
    if (isPromptPlaceholder(raw)) return raw;
    // DEDUPED: the same raw prompt id recurs across message_start/content_block_*/
    // message_complete + the PromptAccepted HTTP body and must map to ONE PROMPT_N.
    // Caller must only pass values that ARE prompt ids (keyed prompt_id/_prompt_id/
    // _prompt_ids) — we do NOT gate on UUID shape, since item_ids/call_id/
    // interrogative_id can also be UUID-shaped and must be left as-is (review C3).
    if (!this.prompts.has(raw)) {
      this.prompts.set(raw, `PROMPT_${this.nextPrompt++}`);
    }
    return this.prompts.get(raw)!;
  }

  /** The real→placeholder prompt map, for the scenario's canonicalization manifest. */
  promptManifest(): Record<string, string> {
    // Sorted for deterministic manifest output (mirrors the Rust BTreeMap).
    return Object.fromEntries([...this.prompts.entries()].sort());
  }
}

/**
 * Recursively rewrite session ids and prompt ids in place. Mirrors
 * corpus.rs::canonicalize_value EXACTLY. Mapping is KEY-driven (prompt_id /
 * *_prompt_id / *_prompt_ids), never UUID-shape-driven: a UUID under a non-prompt
 * key (call_id, item_id, interrogative_id) is left untouched (review C3).
 */
function canonicalizeValue(v: unknown, state: CanonState): unknown {
  if (Array.isArray(v))
    return v.map((child) => canonicalizeValue(child, state));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      if (key === "session_id" && typeof child === "string") {
        out[key] = state.canonSession(child);
        continue;
      }
      // /state leak redactions are KEY-driven and type-preserving. These keys
      // appear only in HTTP /state bodies in the golden corpus, but the recursive
      // canonicalizer handles them wherever they are nested so a future capture
      // cannot leak machine paths, model output, or counters.
      if (key === "env") {
        out[key] = child !== null && typeof child === "object" && !Array.isArray(child) ? {} : child;
        continue;
      }
      if (key === "most_recent_assistant_text") {
        out[key] = typeof child === "string" ? "" : child;
        continue;
      }
      if (key === "used_tokens") {
        out[key] = typeof child === "number" ? 0 : child;
        continue;
      }
      if (key === "project_cwd") {
        out[key] = typeof child === "string" ? "/PROJECT" : child;
        continue;
      }
      if (key === "source_control") {
        if (child !== null && typeof child === "object" && !Array.isArray(child)) {
          const sourceControl = { ...(child as Record<string, unknown>) };
          if (typeof sourceControl.label === "string") sourceControl.label = "BRANCH";
          if (typeof sourceControl.dirty === "boolean") sourceControl.dirty = false;
          for (const leaf of ["commit", "sha", "revision", "head", "upstream"]) {
            if (typeof sourceControl[leaf] === "string") sourceControl[leaf] = "COMMIT";
          }
          out[key] = sourceControl;
        } else {
          out[key] = child;
        }
        continue;
      }
      // Prompt-id key → PROMPT_N (deduped). Matches BOTH singular (prompt_id,
      // admission_prompt_id, final_prompt_id, to_prompt_id, …) AND plural
      // (admission_prompt_ids, prompt_ids). Singular → string maps directly;
      // plural → each STRING element of the array maps directly.
      const isPromptField =
        key === "prompt_id" ||
        key.endsWith("_prompt_id") ||
        key.endsWith("_prompt_ids");
      if (isPromptField) {
        out[key] = Array.isArray(child)
          ? // Plural `*_prompt_ids`: map each string element directly. Recursing via
            // canonicalizeValue would drop the key context (array elements aren't "under
            // a prompt key") and leave the UUIDs raw — a real capture's
            // `admission_prompt_ids` leaked un-canonicalized exactly this way.
            child.map((el) =>
              typeof el === "string"
                ? state.canonPrompt(el)
                : canonicalizeValue(el, state),
            )
          : child !== null && typeof child === "object"
            ? canonicalizeValue(child, state)
            : typeof child === "string"
              ? state.canonPrompt(child)
              : child;
        continue;
      }
      // Other key: recurse into objects/arrays; leave scalars untouched.
      out[key] =
        child !== null && typeof child === "object"
          ? canonicalizeValue(child, state)
          : child;
    }
    return out;
  }
  // Bare scalar under a non-prompt key: untouched (no UUID-shape guessing).
  return v;
}

/** The Nth monotonic-epoch timestamp: `1970-01-01THH:MM:SS.000Z`, frame index as
 *  elapsed seconds. Rolls into minutes/hours so ≥60-frame corpora stay valid
 *  24-char stamps `isMonotonicEpoch` recognizes (review C2). */
const monotonicTimestamp = (frameIdx: number) => {
  const total = frameIdx;
  const secs = total % 60;
  const mins = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600) % 24;
  return `1970-01-01T${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.000Z`;
};

interface HttpEntry {
  method: string;
  path: string;
  request_body: unknown | null;
  status: number;
  response_body: unknown | null;
}
interface SseFrame {
  seq?: number;
  emitted_at: string;
  session_id: string;
  event: Record<string, unknown>;
}
interface ScenarioFile {
  scenario: string;
  version: string;
  description: string;
  canonicalization: {
    session_id: string;
    prompt_ids: Record<string, string>;
    timestamps: string;
  };
  http: HttpEntry[];
  sse: SseFrame[];
  expected_driver_events: null;
}

/** Canonicalize a full recording in place. HTTP is walked BEFORE SSE so prompt-id
 *  numbering (PROMPT_0, PROMPT_1, …) matches the Rust loader's first-seen order. */
export function canonicalizeScenario(
  http: HttpEntry[],
  sse: SseFrame[],
): { http: HttpEntry[]; sse: SseFrame[]; manifest: Record<string, string> } {
  const state = new CanonState();
  const outHttp = http.map((e) => ({
    ...e,
    request_body:
      e.request_body == null ? null : canonicalizeValue(e.request_body, state),
    response_body:
      e.response_body == null
        ? null
        : canonicalizeValue(e.response_body, state),
  }));
  const outSse = sse.map((frame, idx) => {
    const session_id = state.canonSession(frame.session_id);
    const emitted_at = isMonotonicEpoch(frame.emitted_at)
      ? frame.emitted_at
      : monotonicTimestamp(idx);
    const event = canonicalizeValue(frame.event, state) as Record<
      string,
      unknown
    >;
    // The event's inner `timestamp` (heartbeat/system_reminder carry one).
    if (
      typeof event.timestamp === "string" &&
      !isMonotonicEpoch(event.timestamp)
    ) {
      event.timestamp = monotonicTimestamp(idx);
    }
    // The event's inner `emitted_at` (some daemon events carry one).
    if (
      typeof event.emitted_at === "string" &&
      !isMonotonicEpoch(event.emitted_at)
    ) {
      event.emitted_at = monotonicTimestamp(idx);
    }
    return {
      ...(frame.seq != null ? { seq: frame.seq } : {}),
      emitted_at,
      session_id,
      event,
    };
  });
  return { http: outHttp, sse: outSse, manifest: state.promptManifest() };
}

function assertScenarioFile(value: unknown, file: string): asserts value is ScenarioFile {
  if (value === null || typeof value !== "object") {
    throw new Error(`${file}: expected ScenarioFile object`);
  }
  const scenario = value as Partial<ScenarioFile>;
  if (
    typeof scenario.scenario !== "string" ||
    typeof scenario.version !== "string" ||
    typeof scenario.description !== "string" ||
    scenario.canonicalization === null ||
    typeof scenario.canonicalization !== "object" ||
    !Array.isArray(scenario.http) ||
    !Array.isArray(scenario.sse) ||
    !("expected_driver_events" in scenario)
  ) {
    throw new Error(`${file}: invalid ScenarioFile shape`);
  }
}

function recanonPath(arg: string): string {
  return isAbsolute(arg) ? arg : resolve(import.meta.dir, "..", arg);
}

function recanonFile(file: string): void {
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  assertScenarioFile(parsed, file);
  const { http, sse, manifest } = canonicalizeScenario(parsed.http, parsed.sse);
  const out: ScenarioFile = {
    scenario: parsed.scenario,
    version: parsed.version,
    description: parsed.description,
    canonicalization: {
      session_id: "SESSION",
      prompt_ids:
        Object.keys(manifest).length === 0
          ? parsed.canonicalization.prompt_ids
          : manifest,
      timestamps: "monotonic-from-T0",
    },
    http,
    sse,
    expected_driver_events: parsed.expected_driver_events,
  };
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.error(`recanonicalized ${file}`);
}

function recanonCorpus(args: string[]): void {
  const files =
    args.length === 0
      ? readdirSync(CORPUS_DIR)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(CORPUS_DIR, name))
      : args.map(recanonPath);
  if (files.length === 0) {
    throw new Error(`no .json files to recanonicalize in ${CORPUS_DIR}`);
  }
  for (const file of files) recanonFile(file);
}

// ─── Daemon driving ──────────────────────────────────────────────────────────

interface CaptureCtx {
  port: number;
  sessionId: string;
  /** Recorded HTTP request/response pairs, in call order. */
  http: HttpEntry[];
  /** A recorded fetch: POSTs/GETs the daemon AND appends to `http`. */
  call: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** Resolves when the collected SSE contains an event of `type`. */
  waitForEvent: (type: string, timeoutMs?: number) => Promise<void>;
  /** The raw (un-canonicalized) SSE frames collected so far. */
  sse: SseFrame[];
}

// Crockford base32 (no i/l/o/u) — the alphabet polytoken uses for a session id's
// leading timestamp segment.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A daemon-valid session id: `<6 Crockford base32>-corpus`. The daemon
 *  (`0.4.0-unstable.7`) REJECTS an arbitrary id like a UUID — it requires the
 *  segment before the first dash to be exactly 6 Crockford base32 chars (its own
 *  timestamp-segment scheme). We encode the low 30 bits of the epoch (ms) as those
 *  6 chars so sequential captures never collide, then a fixed `corpus` word so the
 *  session is recognizable in the isolated sessions dir. */
function freshSessionId(): string {
  let n = Date.now() & 0x3fffffff; // low 30 bits → 6 base32 chars
  let seg = "";
  for (let i = 0; i < 6; i++) {
    seg = CROCKFORD[n % 32] + seg;
    n = Math.floor(n / 32);
  }
  return `${seg}-corpus`;
}

/** Spawn a fresh (non-resume) isolated daemon session; resolve its port. */
async function spawnFreshDaemon(
  p: Paths,
  permissionMatcher: "bypass_plus" | "standard",
): Promise<{
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  sessionId: string;
}> {
  ensureEnv(p);
  // The permission matcher is baked into config.yaml BEFORE spawn and governs
  // whether the daemon prompts for tool execution. If $PANTOKEN_PARITY_CONFIG_DIR
  // points at a hand-maintained config (generateConfig=false), we can't control
  // it — fail loud rather than silently capture against the wrong matcher (e.g.
  // an unattended `bypass_plus` that would auto-approve `tool-call-approval`).
  if (!p.generateConfig) {
    throw new Error(
      `$PANTOKEN_PARITY_CONFIG_DIR is set, so the capture harness cannot guarantee ` +
        `default_permission_matcher=${permissionMatcher} for this scenario. Unset it to ` +
        `let the harness generate an isolated capture config, or point it at a config that ` +
        `uses the right matcher.`,
    );
  }
  // Write an ISOLATED, per-capture global config carrying the required matcher.
  // Kept OUT of p.globalConfigDir (the shared parity config e2e/other runs rely
  // on) so a `standard` capture never leaves the shared config prompting. Still
  // under PARITY_ROOT, so isolation holds.
  const captureConfigHome = join(p.root, "xdg-config-capture");
  const captureGlobalConfigDir = join(captureConfigHome, "polytoken");
  mkdirSync(captureGlobalConfigDir, { recursive: true });
  writeFileSync(
    join(captureGlobalConfigDir, "config.yaml"),
    renderConfig(p.model, permissionMatcher),
  );
  // `standard` alone does NOT prompt: it means "apply your allow/ask/deny rules",
  // and with no rule file a shell_exec matches nothing and runs unprompted (only
  // `deny`/`ask` rules gate; `bypass_plus` ignores `ask` entirely). So for the
  // `standard` capture we ALSO write a version-2 permissions rule file that FORCES
  // an ask before the shell tools — the approval interrogative then fires
  // deterministically, regardless of how "safe" the command looks. Loaded from the
  // global config dir (same dir as config.yaml). See `polytoken schemas
  // permissions-config` and docs.polytoken.dev/reference/permissions-config.
  //
  // Written UNCONDITIONALLY (empty rule set for bypass_plus) so the reused capture
  // config dir always matches the current matcher — a stale `ask` rule from a prior
  // `standard` capture must never leak into a later `bypass_plus` one.
  writeFileSync(
    join(captureGlobalConfigDir, "permissions.yaml"),
    permissionMatcher === "standard"
      ? "version: 2\nask:\n  - tool: shell_exec\n  - tool: shell_monitor\n"
      : "version: 2\n",
  );
  const sessionId = freshSessionId();
  const proc = Bun.spawn({
    cmd: [
      POLYTOKEN_BIN,
      "daemon",
      "--project-dir",
      p.project,
      "--session-id",
      sessionId,
      "--sessions-dir",
      p.sessionsDir,
      "--global-config-dir",
      captureGlobalConfigDir,
    ],
    env: {
      ...process.env,
      ...isolationEnv(p),
      XDG_CONFIG_HOME: captureConfigHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const su = readStartupJson(sessionId, p);
    if (
      su?.state === "ready" &&
      su.pid === proc.pid &&
      typeof su.port === "number"
    ) {
      return { proc, port: su.port, sessionId };
    }
    if (su?.state === "failed" && su.pid === proc.pid) {
      throw new Error(`fresh daemon failed: ${su.message ?? "no message"}`);
    }
    await Bun.sleep(100);
  }
  const err = await new Response(proc.stderr).text().catch(() => "");
  proc.kill();
  throw new Error(
    `fresh daemon not ready in 20s${err ? `\n${err.slice(0, 400)}` : ""}`,
  );
}

/** Claim the TUI attachment lease and start a heartbeat; return a stop fn. */
async function claimLeaseWithHeartbeat(port: number): Promise<() => void> {
  const res = await fetch(`http://127.0.0.1:${port}/tui-attachment/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid: process.pid, label: "corpus-capture" }),
  });
  if (res.status !== 200) {
    throw new Error(`lease claim failed (${res.status}): ${await res.text()}`);
  }
  const { lease_id, heartbeat_interval_seconds } = (await res.json()) as {
    lease_id: string;
    heartbeat_interval_seconds: number;
  };
  const timer = setInterval(
    () => {
      void fetch(`http://127.0.0.1:${port}/tui-attachment/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lease_id, pid: process.pid }),
      }).catch(() => {});
    },
    Math.max(1, heartbeat_interval_seconds) * 1000,
  );
  return () => clearInterval(timer);
}

/** Subscribe to GET /events, appending each parsed envelope to `sse`. Returns a
 *  stop fn that aborts the stream. */
function subscribeEvents(port: number, sse: SseFrame[]): () => void {
  const ctrl = new AbortController();
  void (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      headers: { accept: "text/event-stream" },
      signal: ctrl.signal,
    }).catch(() => null);
    if (!res?.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader
        .read()
        .catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""));
        if (dataLines.length === 0) continue;
        try {
          sse.push(JSON.parse(dataLines.join("\n")) as SseFrame);
        } catch {
          /* skip malformed frame — fail-loud would abort the whole capture */
        }
      }
    }
  })();
  return () => ctrl.abort();
}

// ─── Scenario registry ───────────────────────────────────────────────────────

interface Scenario {
  description: string;
  /** Drives the daemon through the scenario. Automated scenarios return normally;
   *  unimplemented interactive ones throw with the exact steps to fill in. */
  drive: (ctx: CaptureCtx) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  "streaming-turn": {
    description:
      "A complete assistant turn: prompt → streamed text deltas → message_complete. " +
      "The baseline happy-path streaming sequence.",
    drive: async (ctx) => {
      await ctx.call("GET", "/state");
      await ctx.call("POST", "/prompt", {
        content: "Reply with exactly: Hello!",
        max_tool_turns: null,
      });
      await ctx.waitForEvent("message_complete", 60_000);
      await ctx.call("GET", "/state");
    },
  },

  // ── Interactive scenarios: stubs with the exact driver steps to script. ──
  // Each needs mid-turn driving that a single prompt can't express; fill in the
  // `drive` body when you run the live capture, using the seed fixture's HTTP +
  // SSE shapes as the target. Throwing keeps them from silently writing an empty
  // corpus (fail-loud).
  "tool-call-approval": {
    description:
      "A turn that calls a tool requiring approval → interrogative (permission) → approve → " +
      "tool_result → message_complete.",
    // Runs under an isolated `standard` permission matcher PLUS a version-2
    // permissions rule file that `ask`s before the shell tools (both written by
    // spawnFreshDaemon; main() selects `standard` for this scenario only). Neither
    // alone prompts: `standard` only means "apply your allow/ask/deny rules", and
    // it is the `ask` rule that forces the interrogative before shell_exec (a
    // `bypass_plus` matcher would ignore `ask` entirely). Earlier finding
    // (2026-07-06): a runtime `POST /permission-monitor` switch alone does NOT gate
    // the tool; the monitor call below only governs notifications and is kept as
    // belt-and-suspenders.
    drive: async (ctx) => {
      await ctx.call("POST", "/permission-monitor", { mode: "standard" });
      await ctx.call("GET", "/state");
      await ctx.call("POST", "/prompt", {
        content:
          "Use your shell/command tool to run exactly `echo hello-corpus`. " +
          "Actually run it with the tool; do not just describe it.",
        max_tool_turns: null,
      });
      // Wait for the permission interrogative, then approve it. The respond body
      // is the flat oneOf variant { kind: "permission_answer", granted } — NOT the
      // seed's invalid { response: { kind, decision } } shape.
      const deadline = Date.now() + 120_000;
      let interro: SseFrame | undefined;
      while (Date.now() < deadline && !interro) {
        interro = ctx.sse.find((f) => {
          const t = (f.event as { type?: string })?.type ?? "";
          return t === "interrogative" || t.includes("interrogative");
        });
        if (!interro) await Bun.sleep(200);
      }
      if (!interro) {
        throw new Error(
          "no interrogative within 120s. The capture ran under " +
            "default_permission_matcher: standard, so either the model didn't call the " +
            "tool (transient — re-run) or `standard` did not gate execution (escalate: " +
            "check the daemon permission-matcher docs for the correct gating value — do " +
            "NOT loop on money-spending retries). See server-rs/PROGRESS.md.",
        );
      }
      const id = (interro.event as { interrogative_id?: string })
        .interrogative_id;
      if (!id) {
        throw new Error(
          `interrogative missing interrogative_id: ${JSON.stringify(interro.event)}`,
        );
      }
      await ctx.call("POST", `/interrogative/${id}/respond`, {
        kind: "permission_answer",
        granted: true,
      });
      await ctx.waitForEvent("message_complete", 120_000);
      await ctx.call("GET", "/state");
    },
  },
  "ask-user-question": {
    description:
      "A turn where the model asks the user a structured question (ask_user_question " +
      "interrogative) → the user answers → message_complete.",
    drive: async (ctx) => {
      await ctx.call("GET", "/state");
      await ctx.call("POST", "/prompt", {
        content:
          "I'm torn between two approaches for a small refactor. Use your ask_user_question " +
          "tool to ask which I prefer, with exactly two short options (A: extract a helper; " +
          "B: inline it). Keep the options terse. After I answer, do NOT implement anything — " +
          "reply with just one short sentence acknowledging my choice, then stop.",
        max_tool_turns: null,
      });
      // Wait for the ask_user_question interrogative.
      const deadline = Date.now() + 120_000;
      let auq: SseFrame | undefined;
      while (Date.now() < deadline && !auq) {
        auq = ctx.sse.find(
          (f) => (f.event as { type?: string })?.type === "ask_user_question",
        );
        if (!auq) await Bun.sleep(200);
      }
      if (!auq) {
        throw new Error(
          "no ask_user_question within 120s — model chose not to ask; try a more forcing prompt",
        );
      }
      const ev = auq.event as {
        interrogative_id?: string;
        payload?: {
          questions?: Array<{
            id?: string;
            options?: Array<{ id?: string }>;
          }>;
        };
      };
      const id = ev.interrogative_id;
      const q = ev.payload?.questions?.[0];
      if (!id || !q?.id) {
        throw new Error(
          `ask_user_question missing ids: ${JSON.stringify(ev).slice(0, 400)}`,
        );
      }
      // Answer with the first offered option id if present, else free text. Body is
      // the flat oneOf variant { kind: "ask_user_question_answers", answers: [...] }.
      const firstOption = q.options?.[0]?.id;
      const answer = firstOption
        ? { question_id: q.id, selected_option_ids: [firstOption] }
        : {
            question_id: q.id,
            free_text: "Go with option A (extract a helper).",
          };
      await ctx.call("POST", `/interrogative/${id}/respond`, {
        kind: "ask_user_question_answers",
        answers: [answer],
      });
      await ctx.waitForEvent("message_complete", 120_000);
      await ctx.call("GET", "/state");
    },
  },
  abort: {
    description:
      "A streaming turn aborted mid-flight via POST /turn/cancel → turn_cancelled (user_cancelled).",
    drive: async (ctx) => {
      await ctx.call("GET", "/state");
      await ctx.call("POST", "/prompt", {
        content:
          "Write a very long, detailed essay (at least 2000 words) on the full history of " +
          "computing, from the abacus to modern GPUs. Do not stop early.",
        max_tool_turns: null,
      });
      // First streamed delta ⇒ the turn is genuinely in flight (may be a thinking delta).
      await ctx.waitForEvent("content_block_delta", 60_000);
      await ctx.call("POST", "/turn/cancel");
      await ctx.waitForEvent("turn_cancelled", 30_000);
      await ctx.call("GET", "/state");
    },
  },
  "queue-while-in-flight": {
    description:
      "A prompt sent while a turn is in flight → daemon auto-queues it (202 + queued_item, NOT 409); " +
      "the queue drains and the queued turn runs. Verifies AC.3 against real daemon behavior.",
    drive: async (ctx) => {
      await ctx.call("GET", "/state");
      // A short-but-non-instant first turn: enough of a streaming window that the
      // 2nd prompt reliably lands in-flight, without bloating the golden file.
      await ctx.call("POST", "/prompt", {
        content: "Count from 1 to 5, one number per line.",
        max_tool_turns: null,
      });
      await ctx.waitForEvent("message_start", 60_000);
      // Second prompt WHILE the first turn is in flight → must auto-queue, not 409.
      const accepted = (await ctx.call("POST", "/prompt", {
        content: "Then reply with exactly: QUEUE-DONE",
        max_tool_turns: null,
      })) as { queued_item?: unknown } | null;
      if (!accepted?.queued_item) {
        console.error(
          `WARN: 2nd /prompt carried no queued_item (got ${JSON.stringify(accepted)}) — ` +
            "auto-queue (AC.3) may not be live; capturing anyway.",
        );
      }
      await ctx.waitForEvent("pending_turn_input_queued", 60_000);
      await ctx.waitForEvent("pending_turn_input_drained", 120_000);
      // Both turns should finish (two message_complete events).
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const done = ctx.sse.filter(
          (f) => (f.event as { type?: string })?.type === "message_complete",
        ).length;
        if (done >= 2) break;
        await Bun.sleep(200);
      }
      await ctx.call("GET", "/state");
    },
  },
  "reconnect-stream-discontinuity": {
    description:
      "A reconnect that reseeds via stream_discontinuity (SSE resume is an upstream no-op).",
    drive: async () => {
      throw new Error(
        "reconnect capture not scripted: this scenario asserts RESEED, not resume replay — drop the " +
          "SSE connection mid-turn, reconnect with Last-Event-ID, assert the replay is empty and a " +
          "reseed follows. Not a driver bug; a documented upstream gap.",
      );
    },
  },
};

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const [scenarioName, ...rest] = process.argv.slice(2);
  if (scenarioName === "--recanon") {
    recanonCorpus(rest);
    return;
  }
  const write = rest.includes("--write");
  if (!scenarioName || !(scenarioName in SCENARIOS)) {
    console.error(
      `usage: bun run scripts/capture-daemon-corpus.ts <scenario> [--write]\n` +
        `       bun run scripts/capture-daemon-corpus.ts --recanon [file...]\n` +
        `scenarios: ${Object.keys(SCENARIOS).join(", ")}`,
    );
    process.exit(1);
  }
  const scenario = SCENARIOS[scenarioName]!;
  const p = paths();

  // tool-call-approval needs the daemon to actually PROMPT before running the
  // tool (so we can capture the permission interrogative + approval); every
  // other scenario runs unattended under bypass_plus.
  const permissionMatcher: "bypass_plus" | "standard" =
    scenarioName === "tool-call-approval" ? "standard" : "bypass_plus";

  const { proc, port, sessionId } = await spawnFreshDaemon(p, permissionMatcher);
  const http: HttpEntry[] = [];
  const sse: SseFrame[] = [];
  let stopHeartbeat: (() => void) | null = null;
  let stopEvents: (() => void) | null = null;

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    http.push({
      method,
      path,
      request_body: body ?? null,
      status: res.status,
      response_body: parsed,
    });
    return parsed;
  };

  const waitForEvent = async (
    type: string,
    timeoutMs = 60_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sse.some((f) => (f.event as { type?: string })?.type === type))
        return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting ${timeoutMs}ms for event '${type}'`);
  };

  try {
    stopEvents = subscribeEvents(port, sse);
    stopHeartbeat = await claimLeaseWithHeartbeat(port);
    await scenario.drive({ port, sessionId, http, call, waitForEvent, sse });
  } finally {
    stopEvents?.();
    stopHeartbeat?.();
    await fetch(`http://127.0.0.1:${port}/terminate`, { method: "POST" }).catch(
      () => {},
    );
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  const { http: cHttp, sse: cSse, manifest } = canonicalizeScenario(http, sse);
  const out: ScenarioFile = {
    scenario: scenarioName,
    version: CORPUS_VERSION,
    description: scenario.description,
    canonicalization: {
      session_id: "SESSION",
      prompt_ids: manifest,
      timestamps: "monotonic-from-T0",
    },
    http: cHttp,
    sse: cSse,
    expected_driver_events: null,
  };
  const json = `${JSON.stringify(out, null, 2)}\n`;

  if (write) {
    mkdirSync(CORPUS_DIR, { recursive: true });
    const target = join(CORPUS_DIR, `${scenarioName}.json`);
    writeFileSync(target, json);
    console.error(
      `wrote ${target} (${cSse.length} SSE frames, ${cHttp.length} HTTP calls)`,
    );
    console.error(
      "REVIEW before committing: eyeball the diff, then run `cargo test --test corpus` to " +
        "confirm it still deserializes into the real DaemonEvent enum.",
    );
  } else {
    process.stdout.write(json);
    console.error(`\n(dry run — re-run with --write to save to ${CORPUS_DIR})`);
  }
}

// Only auto-run the capture CLI when invoked directly. Guarding on
// `import.meta.main` lets the cross-language parity test import
// `canonicalizeScenario` without spawning a daemon on import.
if (import.meta.main) {
  main().catch((e) => {
    console.error(`capture failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}

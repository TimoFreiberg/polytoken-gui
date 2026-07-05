#!/usr/bin/env bun
// capture-daemon-corpus.ts — record a golden SSE corpus from a REAL polytoken daemon.
//
// This is the deliberate, separate "live capture" step behind the golden corpus
// (server-rs/tests/corpus/<version>/). The committed seed fixtures ship
// pre-canonicalized and the Rust loader (server-rs/pilot-server/tests/corpus.rs)
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
// timestamps. `canonicalizeScenario` rewrites them to stable placeholders,
// MIRRORING server-rs/pilot-server/tests/corpus.rs EXACTLY (session_id→SESSION,
// UUID prompt ids→PROMPT_N in first-seen order with HTTP walked before SSE,
// emitted_at→monotonic epoch). KNOWN LIMITATION (shared with the Rust loader):
// wall-clock timestamps INSIDE HTTP response bodies (e.g. state `updated_at`) are
// NOT rewritten — the seed HTTP bodies carry none. If a real capture's HTTP bodies
// carry timestamps, extend canonicalizeValue (here AND in corpus.rs together) to
// null/normalize them before freezing, or the corpus will be non-deterministic.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLYTOKEN_BIN,
  type Paths,
  ensureEnv,
  isolationEnv,
  paths,
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

// ─── Canonicalization (mirrors server-rs/pilot-server/tests/corpus.rs) ────────

/** A UUID-shaped string: 8-4-4-4-12 hex with dashes at 8/13/18/23. */
function looksLikeUuid(s: string): boolean {
  if (s.length !== 36) return false;
  if (s[8] !== "-" || s[13] !== "-" || s[18] !== "-" || s[23] !== "-") {
    return false;
  }
  return [...s].every(
    (c, i) => i === 8 || i === 13 || i === 18 || i === 23 || /[0-9a-fA-F]/.test(c),
  );
}
const isPromptPlaceholder = (s: string) => /^PROMPT_\d+$/.test(s);
const isSessionPlaceholder = (s: string) => s === "SESSION";
const isMonotonicEpoch = (s: string) =>
  s.length === 24 && s.startsWith("1970-01-01T00:00:") && s.endsWith(".000Z");

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
    // Only UUID-shaped values are prompt ids; opaque ids (call_id, item_id) stay.
    if (!looksLikeUuid(raw)) return raw;
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
 * Recursively rewrite session ids, prompt ids, and bare-UUID array elements.
 * Mirrors corpus.rs::canonicalize_value EXACTLY, including the subtlety that a
 * scalar string under a NON-special key is left untouched (a bare UUID is only
 * mapped when it's an array element or under a `*_prompt_id` key).
 */
function canonicalizeValue(v: unknown, state: CanonState): unknown {
  if (Array.isArray(v)) return v.map((child) => canonicalizeValue(child, state));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
      if (key === "session_id" && typeof child === "string") {
        out[key] = state.canonSession(child);
        continue;
      }
      const isPromptField = key === "prompt_id" || key.endsWith("_prompt_id");
      if (isPromptField && typeof child === "string") {
        out[key] = state.canonPrompt(child);
        continue;
      }
      // Non-special key: recurse into objects/arrays; leave scalars untouched.
      out[key] =
        child !== null && typeof child === "object"
          ? canonicalizeValue(child, state)
          : child;
    }
    return out;
  }
  if (typeof v === "string" && looksLikeUuid(v)) return state.canonPrompt(v);
  return v;
}

/** The Nth monotonic-epoch timestamp: `1970-01-01T00:00:0N.000Z` (secs capped 59). */
const monotonicTimestamp = (frameIdx: number) =>
  `1970-01-01T00:00:${String(Math.min(frameIdx, 59)).padStart(2, "0")}.000Z`;

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
function canonicalizeScenario(
  http: HttpEntry[],
  sse: SseFrame[],
): { http: HttpEntry[]; sse: SseFrame[]; manifest: Record<string, string> } {
  const state = new CanonState();
  const outHttp = http.map((e) => ({
    ...e,
    request_body:
      e.request_body == null ? null : canonicalizeValue(e.request_body, state),
    response_body:
      e.response_body == null ? null : canonicalizeValue(e.response_body, state),
  }));
  const outSse = sse.map((frame, idx) => {
    const session_id = state.canonSession(frame.session_id);
    const emitted_at = isMonotonicEpoch(frame.emitted_at)
      ? frame.emitted_at
      : monotonicTimestamp(idx);
    const event = canonicalizeValue(frame.event, state) as Record<string, unknown>;
    // The event's inner `timestamp` (heartbeat/system_reminder carry one).
    if (typeof event.timestamp === "string" && !isMonotonicEpoch(event.timestamp)) {
      event.timestamp = monotonicTimestamp(idx);
    }
    return { ...(frame.seq != null ? { seq: frame.seq } : {}), emitted_at, session_id, event };
  });
  return { http: outHttp, sse: outSse, manifest: state.promptManifest() };
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

/** Spawn a fresh (non-resume) isolated daemon session; resolve its port. */
async function spawnFreshDaemon(
  p: Paths,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number; sessionId: string }> {
  ensureEnv(p);
  const sessionId = crypto.randomUUID();
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
      p.globalConfigDir,
    ],
    env: { ...process.env, ...isolationEnv(p) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const su = readStartupJson(sessionId, p);
    if (su?.state === "ready" && su.pid === proc.pid && typeof su.port === "number") {
      return { proc, port: su.port, sessionId };
    }
    if (su?.state === "failed" && su.pid === proc.pid) {
      throw new Error(`fresh daemon failed: ${su.message ?? "no message"}`);
    }
    await Bun.sleep(100);
  }
  const err = await new Response(proc.stderr).text().catch(() => "");
  proc.kill();
  throw new Error(`fresh daemon not ready in 20s${err ? `\n${err.slice(0, 400)}` : ""}`);
}

/** Claim the TUI attachment lease and start a heartbeat; return a stop fn. */
async function claimLeaseWithHeartbeat(
  port: number,
): Promise<() => void> {
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
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
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
      await ctx.call("POST", "/prompt", { content: "Reply with exactly: Hello!", max_tool_turns: null });
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
    description: "A turn that calls a tool requiring approval, then approves it.",
    drive: async () => {
      throw new Error(
        "tool-call-approval capture not scripted: prompt a tool-using task, wait for the " +
          "permission_request event, POST the approval to the interrogative endpoint, then " +
          "collect through tool_result + message_complete. See the seed fixture for the shapes.",
      );
    },
  },
  "ask-user-question": {
    description: "A turn that asks the user a question (interrogative), then answers it.",
    drive: async () => {
      throw new Error(
        "ask-user-question capture not scripted: prompt a task that triggers ask_user_question, " +
          "wait for the interrogative event, POST the answer, collect through message_complete.",
      );
    },
  },
  abort: {
    description: "A streaming turn aborted mid-flight via POST /turn/cancel.",
    drive: async () => {
      throw new Error(
        "abort capture not scripted: prompt a long task, wait for the first content_block_delta, " +
          "POST /turn/cancel, collect the cancellation/turn-end events.",
      );
    },
  },
  "queue-while-in-flight": {
    description:
      "A prompt sent while a turn is in flight → daemon auto-queues it (unstable.6+). " +
      "Verifies AC.3 against real daemon behavior.",
    drive: async () => {
      throw new Error(
        "queue-while-in-flight capture not scripted: POST /prompt, wait for message_start, POST a " +
          "SECOND /prompt while in flight, assert 202 + queued_item (auto-queue, not 409), collect the queue event.",
      );
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
  const write = rest.includes("--write");
  if (!scenarioName || !(scenarioName in SCENARIOS)) {
    console.error(
      `usage: bun run scripts/capture-daemon-corpus.ts <scenario> [--write]\n` +
        `scenarios: ${Object.keys(SCENARIOS).join(", ")}`,
    );
    process.exit(1);
  }
  const scenario = SCENARIOS[scenarioName]!;
  const p = paths();

  const { proc, port, sessionId } = await spawnFreshDaemon(p);
  const http: HttpEntry[] = [];
  const sse: SseFrame[] = [];
  let stopHeartbeat: (() => void) | null = null;
  let stopEvents: (() => void) | null = null;

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
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

  const waitForEvent = async (type: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sse.some((f) => (f.event as { type?: string })?.type === type)) return;
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
    await fetch(`http://127.0.0.1:${port}/terminate`, { method: "POST" }).catch(() => {});
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
    console.error(`wrote ${target} (${cSse.length} SSE frames, ${cHttp.length} HTTP calls)`);
    console.error(
      "REVIEW before committing: eyeball the diff, then run `cargo test --test corpus` to " +
        "confirm it still deserializes into the real DaemonEvent enum.",
    );
  } else {
    process.stdout.write(json);
    console.error(`\n(dry run — re-run with --write to save to ${CORPUS_DIR})`);
  }
}

main().catch((e) => {
  console.error(`capture failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

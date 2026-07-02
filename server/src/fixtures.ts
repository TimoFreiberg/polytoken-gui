// Deterministic mock fixtures. Each script is an ordered list of timed events
// that the mock driver replays. Same script -> same event order -> same rendered
// pixels, so an agent can screenshot any UI state reproducibly without a live model.

import type {
  CommandInfo,
  FileInfo,
  ImageContent,
  ModelOption,
  SessionConfig,
  SessionDriverEvent,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  SessionUsage,
  TrustRequest,
} from "@pilot/protocol";
import {
  PERMISSION_APPROVAL_CHOICES,
  PERMISSION_APPROVAL_LABELS,
  pruneApprovalOptions,
} from "./polytoken/ui-bridge.js";

/** Thinking levels the mock's models "support" — drives the picker's thinking menu. */
export const MOCK_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

/** A deterministic spread of models for the picker (mirrors the daemon's provider:model ids).
 *  `thinkingLevels` vary by model so the new-session draft's effort picker has a
 *  realistic (and e2e-distinguishable) per-model set; DeepSeek Flash is non-reasoning. */
export const MOCK_MODELS: readonly ModelOption[] = [
  {
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    thinkingLevels: MOCK_THINKING_LEVELS,
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    thinkingLevels: MOCK_THINKING_LEVELS,
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    thinkingLevels: ["off"],
  },
  {
    provider: "openai",
    modelId: "gpt-5",
    label: "GPT-5",
    thinkingLevels: ["minimal", "low", "medium", "high"],
  },
];

/** A deterministic spread of slash commands for the composer typeahead — one per
 *  source kind, with names chosen so e2e filtering has distinct prefixes ("re" →
 *  review, "p" → plan/pr, "skill:" → the two skills). The mock doesn't execute them
 *  (sending one just runs the normal scripted reply); the menu is exercised on its own. */
export const MOCK_COMMANDS: readonly CommandInfo[] = [
  {
    name: "review",
    description: "Review the working-copy diff for bugs",
    source: "prompt",
    argumentHint: "[path]",
  },
  {
    name: "plan",
    description: "Draft an implementation plan before coding",
    source: "prompt",
  },
  {
    name: "commit",
    description: "Stage changes and commit with a generated message",
    source: "extension",
  },
  {
    name: "pr",
    description: "Open a pull request for the current branch",
    source: "extension",
  },
  {
    name: "skill:debug",
    description: "Trace a bug end-to-end before forming a hypothesis",
    source: "skill",
  },
  {
    name: "skill:journal",
    description: "Capture a durable judgment for a future session",
    source: "skill",
  },
];

/** A representative project tree for the composer's @-file mention autocomplete.
 *  Includes files and directories; `isDirectory: true` entries get a trailing "/"
 *  in the menu. The mock driver's `listFiles` does case-insensitive substring
 *  matching on `path` and returns up to 20 matches sorted by path length. */
export const MOCK_FILES: readonly FileInfo[] = [
  { path: "README.md", isDirectory: false },
  { path: "AGENTS.md", isDirectory: false },
  { path: "docs", isDirectory: true },
  { path: "docs/DESIGN.md", isDirectory: false },
  { path: "docs/DECISIONS.md", isDirectory: false },
  { path: "docs/TODO.md", isDirectory: false },
  { path: "docs/DONE.md", isDirectory: false },
  { path: "docs/OPEN-QUESTIONS.md", isDirectory: false },
  { path: "docs/design-system-pass.md", isDirectory: false },
  { path: "server", isDirectory: true },
  { path: "server/src/index.ts", isDirectory: false },
  { path: "server/src/hub.ts", isDirectory: false },
  { path: "server/src/driver.ts", isDirectory: false },
  { path: "server/src/mock-driver.ts", isDirectory: false },
  { path: "server/src/hub.test.ts", isDirectory: false },
  { path: "server/src/fixtures.ts", isDirectory: false },
  { path: "server/src/polytoken/polytoken-driver.ts", isDirectory: false },
  { path: "client", isDirectory: true },
  { path: "client/src/app.css", isDirectory: false },
  { path: "client/src/components/Composer.svelte", isDirectory: false },
  { path: "client/src/components/SlashMenu.svelte", isDirectory: false },
  { path: "client/src/lib/store.svelte.ts", isDirectory: false },
  { path: "client/src/lib/slash.ts", isDirectory: false },
  { path: "client/src/lib/slash.test.ts", isDirectory: false },
  { path: "client/src/lib/ws.svelte.ts", isDirectory: false },
  { path: "e2e", isDirectory: true },
  { path: "e2e/slash.e2e.ts", isDirectory: false },
  { path: "e2e/composer-resize.e2e.ts", isDirectory: false },
  { path: "protocol", isDirectory: true },
  { path: "protocol/src/wire.ts", isDirectory: false },
  { path: "protocol/src/session-driver.ts", isDirectory: false },
  { path: "protocol/src/state.ts", isDirectory: false },
  { path: "package.json", isDirectory: false },
  { path: "tsconfig.json", isDirectory: false },
];

/** The mock's context-window fill, for the composer meter. ~24% of Opus's 200k
 *  window — a clearly-partial gauge that's deterministic for screenshots/e2e. */
export const MOCK_USAGE: SessionUsage = {
  tokens: 47200,
  contextWindow: 200000,
  percent: 23.6,
};

/** A nearly-full window, so the sidebar/meter ring exercises the hot-color band
 *  (82% → dark orange) next to MOCK_USAGE's healthy green. */
export const MOCK_USAGE_HIGH: SessionUsage = {
  tokens: 164000,
  contextWindow: 200000,
  percent: 82,
};

/** A window in the danger band (91%), past the composer's ≥85% context-pressure cue
 *  threshold. Driven by the `contextfull` dev script so screenshots/e2e can exercise the
 *  "Context nearly full" nudge + its red tone. */
export const MOCK_USAGE_FULL: SessionUsage = {
  tokens: 182000,
  contextWindow: 200000,
  percent: 91,
};

/** The mock's starting model selection (matches the greeting snapshot). */
export const MOCK_DEFAULT_CONFIG: SessionConfig = {
  provider: "anthropic",
  modelId: "claude-opus-4-8",
  thinkingLevel: "medium",
  availableThinkingLevels: MOCK_THINKING_LEVELS,
};

/** A sample background-model spec the mock seeds on boot so the Settings "Models"
 *  section shows a populated, cleanly-resolving control in the dev preview (the
 *  e2e's `reset()` wipes it back to null before each test for a deterministic
 *  baseline). Resolves against `MOCK_MODELS` — picks the cheaper of the two Anthropic
 *  models in the fixture list with a low thinking level, the shape a real
 *  background-model setting takes. */
export const MOCK_BACKGROUND_MODEL = "anthropic/claude-sonnet-4-6:low";

export const WORKSPACE = {
  workspaceId: "ws-demo",
  path: "/Users/timo/src/pilot",
  displayName: "pilot",
} as const;

export const SESSION_REF: SessionRef = {
  workspaceId: WORKSPACE.workspaceId,
  sessionId: "demo-session",
};

// A monotonic mock clock, in milliseconds. Each event advances it a small fixed step
// so successive events have a realistic (but deterministic) sub-second spread; tool
// spans bump it further (advanceTs) so a toolStarted→toolFinished duration renders as a
// legible badge instead of ~1ms. Deterministic: no Date.now()/random — the same script
// always yields the same timestamps, so fold output + screenshots stay stable.
let _ts = 0;
/** Per-event base advance (ms). Small, so non-tool events don't drift wildly apart. */
const TS_STEP_MS = 5;
function ts(): string {
  _ts += TS_STEP_MS;
  return String(_ts).padStart(10, "0");
}
/** Bump the mock clock by `ms` WITHOUT emitting an event — used between a tool's start
 *  and finish so the derived duration badge reads realistically (hundreds of ms to a
 *  few seconds). Returns nothing; call it for its side effect on the shared counter. */
function advanceTs(ms: number): void {
  _ts += ms;
}

export function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ref: SESSION_REF,
    workspace: WORKSPACE,
    title: "Wire up the WebSocket bridge",
    status: "idle",
    updatedAt: ts(),
    config: MOCK_DEFAULT_CONFIG,
    usage: MOCK_USAGE,
    // Default permission-monitor mode — the mock has no daemon to GET, so seed
    // "standard" here so the composer-toolbar badge is non-empty on load.
    permissionMonitor: "standard",
    adventurousHandoff: false,
    notificationAutodrain: false,
    ...over,
  };
}

export interface ScriptStep {
  readonly wait: number; // ms to wait before emitting, relative to previous step
  readonly event: SessionDriverEvent;
}

function base() {
  return { sessionRef: SESSION_REF, timestamp: ts() };
}

/** A matched toolStarted → toolFinished pair with a DETERMINISTIC duration: the clock is
 *  bumped by `durationMs` between stamping the two events, so the card's elapsed badge
 *  reads realistically (the raw `ts()` counter alone makes every span ~1 step). `wait` is
 *  the script delay before the finished event fires (the visible "running" dwell); it's
 *  independent of `durationMs` (the rendered duration) so the two can differ. */
function toolSpan(
  started: Omit<
    Extract<SessionDriverEvent, { type: "toolStarted" }>,
    keyof ReturnType<typeof base> | "type"
  >,
  finished: Omit<
    Extract<SessionDriverEvent, { type: "toolFinished" }>,
    keyof ReturnType<typeof base> | "type"
  >,
  opts: { startWait?: number; wait: number; durationMs: number },
): ScriptStep[] {
  const startEvent: SessionDriverEvent = {
    ...base(),
    type: "toolStarted",
    ...started,
  };
  advanceTs(opts.durationMs);
  const finishEvent: SessionDriverEvent = {
    ...base(),
    type: "toolFinished",
    ...finished,
  };
  return [
    { wait: opts.startWait ?? 0, event: startEvent },
    { wait: opts.wait, event: finishEvent },
  ];
}

/** Split text into streaming deltas of a few words each. */
function deltas(
  text: string,
  channel: "text" | "thinking",
  chunk = 3,
): ScriptStep[] {
  const words = text.split(/(\s+)/);
  const steps: ScriptStep[] = [];
  let buf = "";
  let n = 0;
  for (const w of words) {
    buf += w;
    if (++n % chunk === 0) {
      steps.push({
        wait: 28,
        event: { ...base(), type: "assistantDelta", text: buf, channel },
      });
      buf = "";
    }
  }
  if (buf)
    steps.push({
      wait: 28,
      event: { ...base(), type: "assistantDelta", text: buf, channel },
    });
  return steps;
}

// --- The conversation already present on first load -------------------------

/** The first prompt in the greeting fixture, reused by the mock's branchFrom so a
 *  branch-from-this-prompt re-edit prefills the composer with the exact text. */
export const GREETING_PROMPT =
  "Add a /health route to the server and a smoke test for it.";

export function greeting(): ScriptStep[] {
  const steps: ScriptStep[] = [
    {
      wait: 0,
      event: { ...base(), type: "sessionOpened", snapshot: snapshot() },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: "u1",
        text: GREETING_PROMPT,
        // Mock branch handle: a stable daemon-style entry id so the user prompt offers a
        // "branch from this prompt" button (the real driver supplies these from the daemon).
        entryId: "e-u1",
      },
    },
  ];
  // Simulate ~37s of working wall-clock between the prompt and the settled reply, so the
  // collapsed "Worked for Ns" header reads realistically on first load (the mock clock is
  // otherwise compressed to a few ms). Only shifts absolute timestamps forward; per-tool
  // span durations are computed inside toolSpan and are unaffected.
  advanceTs(36_600);
  steps.push(
    ...deltas(
      "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.",
      "text",
    ),
    ...toolSpan(
      {
        callId: "t1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: 'rg -n "app.get\\(" server/src' },
      },
      {
        callId: "t1",
        success: true,
        output:
          "server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)",
      },
      // ~340ms span: a quick ripgrep. startWait keeps the original pre-tool think pause.
      { startWait: 120, wait: 220, durationMs: 340 },
    ),
    ...deltas(
      "Routes live in `server/src/index.ts`. I'll register `/health` next to the others and add a Bun test.",
      "text",
    ),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
        // Branch handles for this turn so the turn-final assistant offers "branch from
        // here" (the reducer backfills the live transcript from these).
        userEntryId: "e-u1",
        assistantEntryId: "e-a1",
      },
    },
  );
  return steps;
}

/** Seed for a branch that rewound to before the first prompt: an empty transcript the
 *  hub re-broadcasts (the mock's branchFrom returns this for the user-prompt target). */
export function branchedSeed(): SessionDriverEvent[] {
  return [
    {
      ...base(),
      type: "sessionOpened",
      snapshot: snapshot({ status: "idle" }),
    },
  ];
}

// --- A rich-markdown turn for verifying full markdown rendering -------------

const MARKDOWN_SAMPLE = [
  "## Markdown showcase",
  "",
  "Here's **bold**, *italic*, ~~struck~~, and `inline code`, plus a [link](https://example.com).",
  "",
  "### A table",
  "",
  "| Feature     | Status |",
  "| ----------- | ------ |",
  "| Headers     | done   |",
  "| Tables      | done   |",
  "| Code blocks | done   |",
  "",
  "### A wide table",
  "",
  "A many-columned table is wider than a phone screen; it must scroll",
  "horizontally instead of overflowing the viewport.",
  "",
  "| Country | Capital  | Population | Currency | Language   | Continent     | CallingCode |",
  "| ------- | -------- | ---------- | -------- | ---------- | ------------- | ----------- |",
  "| Japan   | Tokyo    | 125.7M     | JPY      | Japanese   | Asia          | +81         |",
  "| Brazil  | Brasília | 214.3M     | BRL      | Portuguese | South America | +55         |",
  "",
  "### A list",
  "",
  "1. First item",
  "2. Second item",
  "   - nested bullet",
  "   - another",
  "",
  "> A blockquote, for good measure.",
  "",
  "```ts",
  "function greet(name: string) {",
  "  return `hello, ${name}`;",
  "}",
  "```",
].join("\n");

/** Stream a turn that exercises headers, tables, lists, blockquotes, code, and
 *  inline emphasis — driven by the `markdown` dev-bar button and the e2e suite to
 *  verify full markdown rendering (markstream-svelte). */
export function markdownShowcase(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
        text: "Show me a markdown formatting sample.",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas(MARKDOWN_SAMPLE, "text"),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

// --- The default streamed reply to any prompt -------------------------------

export function promptReply(
  userText: string,
  userId?: string,
  images?: readonly ImageContent[],
): ScriptStep[] {
  const callId = `t-${ts()}`;
  // Stable branch handles for this turn, derived from the user message id so the turn-final
  // assistant offers "branch from here" and the prompt offers "branch from this prompt" —
  // mirroring the real daemon, which backfills an entry id on every settled turn. (The greeting
  // fixture already does this; promptReply lagged, which left sent-prompt turns without
  // handles and the active-path tip detection unable to tell a real leaf from a stale one.)
  const uId = userId ?? `u-${ts()}`;
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: uId,
        text: userText,
        images,
        entryId: `e-${uId}`,
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Let me think about the cleanest way to do that.", "thinking"),
    ...deltas(
      "Good question. Here's the plan: I'll start by checking the existing structure, then make the change incrementally so each step is verifiable.",
      "text",
    ),
    ...toolSpan(
      {
        callId,
        toolName: "read",
        label: "Read file",
        description: "Read a file from the workspace",
        input: { path: "server/src/index.ts" },
      },
      {
        callId,
        success: true,
        output: "// 42 lines — Bun.serve with WS + /debug/state",
      },
      // ~1.2s span: a file read that touches disk, so the badge shows whole-seconds too.
      { startWait: 140, wait: 260, durationMs: 1200 },
    ),
    ...deltas(
      "That confirms it. Making the change now and then I'll verify it builds.",
      "text",
    ),
    {
      wait: 80,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
        userEntryId: `e-${uId}`,
        assistantEntryId: `e-a-${uId}`,
      },
    },
  ];
}

// --- A burst of summarized tools, to exercise the tool-summary card ----------

/** One scripted summarized call with a deterministic span. */
function summarySpan(
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
): ScriptStep[] {
  return toolSpan(
    {
      callId,
      toolName,
      label: toolName,
      description: `Run ${toolName}`,
      input,
    },
    { callId, success: true, output },
    { startWait: 40, wait: 90, durationMs: 180 },
  );
}

/** A mixed, uninterrupted burst of tools (2 reads, 2 greps, 1 find, 1 bash).
 *  They all collapse into ONE summary card whose header reads "6 tools" with
 *  "read, grep, find, bash" as its preview — exercising heterogeneous runs,
 *  distinct-name deduping, bash folding, and the two-step drill-down. */
export function searchBatch(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
        text: "Where is the WebSocket reconnect logic?",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Let me poke around the codebase a few ways.", "text"),
    ...summarySpan(
      "r1",
      "read",
      { path: "client/src/lib/store.svelte.ts" },
      "// store.svelte.ts\n  private reconnect() { /* WS singleton backoff */ }",
    ),
    ...summarySpan(
      "r2",
      "read",
      { path: "client/src/App.svelte" },
      "// App.svelte — mounts the store and the transcript",
    ),
    ...summarySpan(
      "g1",
      "grep",
      { pattern: "reconnect", path: "client/src" },
      "client/src/lib/store.svelte.ts:88:  private reconnect() {",
    ),
    ...summarySpan(
      "g2",
      "grep",
      { pattern: "WebSocket", path: "client/src" },
      "client/src/lib/store.svelte.ts:31:    this.ws = new WebSocket(url);",
    ),
    ...summarySpan(
      "f1",
      "find",
      { pattern: "*.svelte", path: "client/src/components" },
      "client/src/components/Transcript.svelte\nclient/src/components/ToolCard.svelte",
    ),
    ...summarySpan(
      "b1",
      "bash",
      { command: 'rg -n "reconnect" client/src/lib' },
      "client/src/lib/store.svelte.ts:88:  private reconnect() {",
    ),
    ...deltas("Reconnect lives in the store's WS singleton.", "text"),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

// --- Tools interleaved with thinking, to exercise hidden-thinking merging ----

/** A turn where the agent thinks between every tool call: bash → think → bash → think
 *  → read → think → bash. Each tool starts a fresh assistant bubble (toolStarted closes
 *  the open one), so the thinking lands as standalone thinking-only items BETWEEN the
 *  tool cards. With thinking VISIBLE the run fragments into separate cards (one per
 *  tool, thinking blocks between); with thinking HIDDEN those gaps render nothing, so
 *  mergeTools drops them and the four tools fold into ONE summary card. */
export function thinkingBetweenTools(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
        text: "Trace the reconnect path and check it end-to-end.",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...summarySpan(
      `tbt-1-${ts()}`,
      "bash",
      { command: "ls client/src/lib" },
      "store.svelte.ts\nws.ts",
    ),
    ...deltas(
      "That lists the lib dir. The WS singleton is the likely home.",
      "thinking",
    ),
    ...summarySpan(
      `tbt-2-${ts()}`,
      "bash",
      { command: "rg -n reconnect client/src" },
      "ws.ts:88: scheduleReconnect()",
    ),
    ...deltas(
      "Found the scheduler. Let me read the file to confirm the backoff.",
      "thinking",
    ),
    ...summarySpan(
      `tbt-3-${ts()}`,
      "read",
      { path: "client/src/lib/ws.ts" },
      "// reconnecting WS singleton",
    ),
    ...deltas(
      "Backoff looks right. One more check on the call site.",
      "thinking",
    ),
    ...summarySpan(
      `tbt-4-${ts()}`,
      "bash",
      { command: "rg -n scheduleReconnect client/src" },
      "ws.ts:88\nws.ts:142",
    ),
    ...deltas(
      "Reconnect is wired correctly — exponential backoff, capped, re-armed on close.",
      "text",
    ),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

// --- A run that loads a skill (read of a SKILL.md) ---------------------------

/** A turn where the agent loads a skill before working: it reads a `SKILL.md` (which
 *  the transcript detects and labels "loaded skill X"), then a normal file, then runs a
 *  command. The three fold into one subdued summary reading
 *  "Loaded skill debug, read a file, ran a command" — exercising skill detection and the
 *  skill-aware prose summarizer. */
export function skillLoad(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
        text: "Something's off with the fold reducer — can you dig in?",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas(
      "This calls for the debug skill — let me load it, then trace the reducer.",
      "text",
    ),
    ...summarySpan(
      "sk1",
      "read",
      { path: ".pi/skills/debug/SKILL.md" },
      "# debug\nTrace the code path end-to-end before forming a hypothesis…",
    ),
    ...summarySpan(
      "sk2",
      "read",
      { path: "protocol/src/state.ts" },
      "// foldEvent — mutates state, returns it",
    ),
    ...summarySpan(
      "sk3",
      "bash",
      { command: "bun test protocol/src/state.test.ts" },
      "✓ 12 pass\n0 fail",
    ),
    ...deltas(
      "The reducer is fine; the stray caret came from a missed assistant close. Fixing that.",
      "text",
    ),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

// --- Approval dialogs -------------------------------------------------------

export function confirmDialog(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "req-confirm-1",
          title: "Run destructive command?",
          message:
            "The agent wants to run `git reset --hard origin/main`. This discards all local changes. Allow?",
          defaultValue: false,
          timeoutMs: 60000,
        },
      },
    },
  ];
}

export function goalProposal(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "req-goal-1",
          title: "Ship feature X",
          message: "Implement the new dashboard widget",
        },
      },
    },
  ];
}

export function unknownInterrogative(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "req-unknown-1",
          title: "⚠ Unknown request type: some_future_type",
          message:
            "The agent sent a request type this version of pilot doesn't recognize. Dismiss to cancel it and unblock the session.",
        },
      },
    },
  ];
}

// The interactive project-trust card (D12). NOT a ScriptStep — it rides the driver's
// out-of-band trust channel, not the session event stream — so the mock emits it
// directly via emitTrust rather than through play(). Mirrors the five options the daemon's CLI
// selector offers for an untrusted cwd with gated .pi resources.
export function mockTrustRequest(): TrustRequest {
  return {
    requestId: "req-trust-1",
    cwd: "/Users/timo/src/untrusted-repo",
    title: "Trust this project folder?",
    options: [
      { label: "Trust this folder", trusted: true },
      { label: "Trust parent folder", trusted: true },
      { label: "Trust for this session only", trusted: true },
      { label: "Don't trust", trusted: false },
      { label: "Don't trust (this session)", trusted: false },
    ],
  };
}

export function inputDialog(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "input",
          requestId: "req-input-1",
          title: "Commit message",
          placeholder: "Describe the change…",
          initialValue: "Add /health route",
        },
      },
    },
  ];
}

// A purpose-built Q&A form (the answer extension's remote face): a single-select
// card, a multi-select card, and a free-text card — enough to exercise every
// render mode plus the prev/next navigation.
export function qnaDialog(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "qna",
          requestId: "req-qna-1",
          title: "A few questions before I proceed",
          questions: [
            {
              question: "Which package manager should I use?",
              context: "The repo has both a bun.lock and a package-lock.json.",
              options: [
                { label: "bun", description: "Matches bun.lock (recommended)" },
                { label: "npm", description: "Matches package-lock.json" },
                { label: "pnpm" },
              ],
            },
            {
              question: "Which checks should run before each commit?",
              multiSelect: true,
              options: [
                { label: "Typecheck" },
                { label: "Unit tests" },
                { label: "Lint" },
                { label: "e2e" },
              ],
            },
            {
              question: "Anything else I should know before starting?",
            },
          ],
        },
      },
    },
  ];
}

// --- Ambient (fire-and-forget) UI -------------------------------------------

export function ambient(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "status",
          requestId: "s1",
          key: "branch",
          text: "on main · 2 files changed",
        },
      },
    },
    {
      wait: 80,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "widget",
          requestId: "w1",
          key: "tasklist",
          // Matches the tasklist extension's real wire format so the client's
          // collapsed-pill rendering is exercised by the dev bar + e2e. [OPEN B]: the
          // item lines carry just the description (the #id is internal-only).
          lines: [
            "Open Tasks (3):",
            "  ○ wire up /health route",
            "  ○ add a smoke test",
            "  ○ document the deploy step",
          ],
          placement: "aboveComposer",
        },
      },
    },
    {
      wait: 80,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "notify",
          requestId: "n1",
          message: "Background indexing finished",
          level: "info",
        },
      },
    },
  ];
}

/** Push the focused session's context meter into the danger band (91%) via a lone
 *  `usageUpdated` — the same mid-turn refresh shape the hub emits — so the composer's
 *  ≥85% context-pressure cue lights up for screenshots/e2e. */
export function contextFull(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: { ...base(), type: "usageUpdated", usage: MOCK_USAGE_FULL },
    },
  ];
}

/** An extension reaching for a terminal-only capability against pilot's non-tui
 *  host — folds into a warning notice. Mirrors what the real driver emits when
 *  an extension's `ui.custom()` call goes unhandled. */
export function compat(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "extensionCompatibilityIssue",
        issue: {
          capability: "custom",
          classification: "terminal-only",
          message:
            "Custom UI is not available in the pilot remote; run the agent in a terminal for this workflow.",
          extensionPath: "~/.pi/agent/extensions/fancy-tui.ts",
          eventName: "session_start",
        },
      },
    },
  ];
}

export function errorRun(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Attempting the network call now.", "text"),
    {
      wait: 120,
      event: {
        ...base(),
        type: "runFailed",
        error: {
          message:
            "Provider request failed: 529 overloaded (will not auto-retry)",
        },
      },
    },
  ];
}

/** Drive a BACKGROUND session (the non-focused `older-session`) through a
 *  running → done turn. The events carry that session's ref, so the hub tracks its
 *  running state + broadcasts `sessionStatus` without folding it into the focused
 *  transcript — exercising the sidebar's running-dots → unread-dot transition
 *  deterministically (dev bar `bgrun`, e2e). */
export function bgRun(): ScriptStep[] {
  const ref = sessionRefFor("older-session");
  const b = () => ({ sessionRef: ref, timestamp: ts() });
  const snap = (status: SessionSnapshot["status"]): SessionSnapshot => ({
    ref,
    workspace: WORKSPACE,
    title: "Explore the fold reducer",
    status,
    updatedAt: ts(),
  });
  return [
    {
      wait: 0,
      event: { ...b(), type: "sessionUpdated", snapshot: snap("running") },
    },
    {
      wait: 300,
      event: {
        ...b(),
        type: "assistantDelta",
        text: "(background turn)",
        channel: "text",
      },
    },
    {
      wait: 1500,
      event: { ...b(), type: "runCompleted", snapshot: snap("idle") },
    },
  ];
}

/** Leave a background session blocked on an approval after reporting useful activity.
 * Opening that session replays the mock driver's retained pending dialog. */
export function bgWait(): ScriptStep[] {
  const ref = sessionRefFor("older-session");
  const b = () => ({ sessionRef: ref, timestamp: ts() });
  const snap: SessionSnapshot = {
    ref,
    workspace: WORKSPACE,
    title: "Explore the fold reducer",
    status: "running",
    updatedAt: ts(),
  };
  return [
    {
      wait: 0,
      event: { ...b(), type: "sessionUpdated", snapshot: snap },
    },
    {
      wait: 80,
      event: {
        ...b(),
        type: "toolStarted",
        callId: "bg-read",
        toolName: "read",
        label: "Read file",
        input: { path: "docs/TODO.md" },
      },
    },
    {
      wait: 120,
      event: {
        ...b(),
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "bg-approval",
          title: "Review background change",
          message: "Apply the queued background edit?",
        },
      },
    },
  ];
}

// --- Polish-batch fixtures (edit-diff card, caret-on-idle, countdown, yes/no) --

/** An edit-tool call + result, so the ToolCard's diff UX (collapsed +N/−M badge +
 *  expandable @pierre/diffs view) can be exercised deterministically. */
export function editDiff(): ScriptStep[] {
  return [
    ...toolSpan(
      {
        callId: "edit-1",
        toolName: "edit",
        label: "Edit file",
        description: "Apply edits to a file in the workspace",
        input: {
          path: "server/src/health.ts",
          edits: [
            {
              oldText:
                'export function health() {\n  return new Response("ok");\n}',
              newText:
                'export function health() {\n  return Response.json({ status: "ok", uptime: process.uptime() });\n}',
            },
          ],
        },
      },
      {
        callId: "edit-1",
        success: true,
        output: "Successfully replaced 1 block(s) in server/src/health.ts",
      },
      // ~480ms span: a single-block edit.
      { wait: 200, durationMs: 480 },
    ),
  ];
}

/** A full turn whose bash tool returns a long log — overflows the ToolCard output cap so
 *  the copy + expand affordances have something to act on. Deterministic line set. */
export function longOutput(): ScriptStep[] {
  const log = Array.from(
    { length: 40 },
    (_, i) =>
      `[${String(i + 1).padStart(2, "0")}] test/case-${i + 1}.spec.ts … ok (${(i + 1) * 3}ms)`,
  ).join("\n");
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
        text: "Run the test suite and show me the output.",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Running the suite now.", "text"),
    ...toolSpan(
      {
        callId: "long-1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: "bun test --reporter=verbose" },
      },
      { callId: "long-1", success: true, output: `${log}\n\n40 pass, 0 fail` },
      { startWait: 120, wait: 200, durationMs: 620 },
    ),
    ...deltas("All 40 cases passed.", "text"),
    {
      wait: 80,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

// Tiny deterministic PNGs (solid-color rectangles) embedded so the image-render paths
// have a reproducible fixture without touching disk. Generated by a minimal RGB PNG
// encoder (no deps). Indigo = a mockup a tool returned; terracotta = a screenshot the
// user attached. Small enough to inline; the bytes never change, so screenshots stay stable.
const MOCKUP_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwE9pDFMazBQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEX9RS5koKflW4AAAAASUVORK5CYII=";
const SHOT_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAqElEQVR4nO3QAQkAIADAMFMaw5QGs4XCHTzA2dhr6kLj+cEngQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnQr0KBbgQbdCjToVqBBtwINuhVo0K1Ag24FGnSrA0Iub1g8jaYyAAAAAElFTkSuQmCC";

/** Exercises BOTH image-render paths in one turn: the user attaches a screenshot, and the
 *  agent runs a tool that returns an image content block (the daemon's `{type:"image"}`). Drives
 *  ToolCard's <img> output + the user-attachment echo in the transcript. */
export function imageReply(): ScriptStep[] {
  const callId = `img-${ts()}`;
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
        text: "Here's the current screen — can you mock up a cleaner layout?",
        images: [{ type: "image", data: SHOT_PNG_B64, mimeType: "image/png" }],
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas(
      "Sure — let me render a quick mockup and show it to you.",
      "text",
    ),
    ...toolSpan(
      {
        callId,
        toolName: "render_mockup",
        label: "Render mockup",
        description: "Render a UI mockup to a PNG and return it",
        input: { spec: "two-column layout, sticky header" },
      },
      {
        callId,
        success: true,
        // Mirror the real driver: image blocks are lifted into the typed `images` field
        // and stripped from `output` (no double-shipping the base64).
        output: {
          content: [{ type: "text", text: "Rendered mockup (160×100 PNG)." }],
        },
        images: [
          { type: "image", data: MOCKUP_PNG_B64, mimeType: "image/png" },
        ],
      },
      // ~900ms span: a render that produces an image.
      { startWait: 140, wait: 320, durationMs: 900 },
    ),
    ...deltas(
      "Here's the mockup — a two-column layout with a sticky header. Want me to wire it up?",
      "text",
    ),
    {
      wait: 80,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

/** A turn that goes running and STAYS running (no completion) so the composer's
 *  steer/follow-up controls + Enter/Alt+Enter hotkeys can be exercised
 *  deterministically — the running state otherwise lasts only ~1s. */
export function streamHold(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Working on it — this turn stays open for the test.", "text"),
  ];
}

/** A turn that goes running with a user message and stays in the THINKING phase — no
 *  assistant answer text, no tool, no runCompleted. The deterministic "prompt sent, the
 *  agent hasn't responded yet" state for the Escape-to-abort restore test: `abortRestoreText`
 *  returns the user text because nothing after the user message emitted output. */
export function pendingHold(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-pending-${ts()}`,
        text: "Refactor the auth middleware",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas(
      "Let me look at how auth is wired before I touch it.",
      "thinking",
    ),
  ];
}

/** A turn that streams an assistant line and then goes idle via `sessionUpdated`
 *  ONLY (no runCompleted) — the original "stray caret" repro. With the fold fix the
 *  caret must NOT linger after the idle transition. */
export function idleNoComplete(): ScriptStep[] {
  return [
    {
      // Begin a proper turn: the userMessage closes any still-open assistant
      // (foldEvent), so this fixture never merges into a prior streaming bubble.
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-idle-${ts()}`,
        text: "End this turn without a runCompleted, please.",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas(
      "Done — this turn ends with a status update, not a runCompleted event.",
      "text",
    ),
    {
      wait: 80,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

/** Reproduces the "missing stop affordance while running" bug: a turn goes running,
 *  streams text, starts a tool, and then a STRAY `sessionUpdated(idle)` lands while the
 *  tool is still executing (the real trigger: an out-of-band re-snapshot mid-turn — a
 *  rename / model change / the daemon's auto-title via `session_info_changed` — taken at an instant
 *  the daemon's `isStreaming` reads false during a tool gap). The folded `session.status` flips to
 *  idle and the hub's running set clears, yet the run is plainly still in flight (the tool
 *  never finished). The robust `turnActive` signal must keep the stop pill + working
 *  indicator visible here; before the fix they vanished. The turn deliberately never
 *  completes, so the stuck state is stable to assert on. */
export function staleIdle(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-stale-${ts()}`,
        text: "Run the long thing — but glitch the status mid-turn.",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("On it — kicking off a command that takes a while.", "text"),
    {
      wait: 40,
      event: {
        ...base(),
        type: "toolStarted",
        callId: "stale-tool-1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: "sleep 30 && echo done" },
      },
    },
    {
      // The stray idle snapshot — corrupts the folded status mid-turn. No toolFinished
      // follows, so the tool stays "running" and the run is unmistakably still live.
      wait: 60,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

/** A confirm dialog with a SHORT timeout, to exercise the countdown + deny-safe
 *  auto-resolve without an e2e waiting a full minute. */
export function timeoutConfirm(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "req-timeout-1",
          title: "Auto-resolving confirm",
          message:
            "This dialog auto-dismisses (deny-safe) if you don't respond.",
          defaultValue: false,
          timeoutMs: 3000,
        },
      },
    },
  ];
}

/** A binary select whose affirmative option comes SECOND, to verify the Yes/No card
 *  promotes the affirmative to the primary (right) button regardless of array order. */
export function yesNoSelect(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "select",
          requestId: "req-yesno-1",
          title: "Apply the suggested fix?",
          options: ["Don't allow", "Allow"],
        },
      },
    },
  ];
}

/** A 3-option select (non-binary, so it renders the radiogroup option list rather than a
 *  Yes/No card) — drives the arrow-key roving + radio semantics. */
export function selectMany(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "select",
          requestId: "req-select-many-1",
          title: "Which environment should I deploy to?",
          options: ["staging", "production", "canary"],
        },
      },
    },
  ];
}

/** A plan-handoff approval card: renders the plan markdown body + 3 action buttons
 *  (Implement new context | Implement current context | Cancel). Exercises the
 *  `plan` HostUiRequest kind, the scrollable Markdown region, and the 3-up action
 *  layout. The planText is multi-paragraph (headings, a list, a code block) so the
 *  scroll cap + markdown rendering both get coverage. */
export function planHandoff(): ScriptStep[] {
  const planText = `# Plan: Add facet indicator + plan-handoff card

## Goal
Stop discarding plan-mode data the daemon already streams. Render the plan
markdown in the handoff card and show a facet badge in the header.

## Steps
1. Add a \`plan\` variant to \`HostUiRequest\` in the protocol.
2. Thread \`plan_text\` through the server event-map.
3. Render markdown + 3 buttons in \`ApprovalLayer.svelte\`.
4. Add a facet badge to \`StatusHeader.svelte\`.

## Code
\`\`\`ts
case "plan_handoff": {
  const ph = ev.plan_handoff;
  const labels = ph
    ? [ph.action_labels.implement_new_context,
       ph.action_labels.implement_current_context,
       ph.action_labels.cancel]
    : ["Implement (new context)", "Implement (current context)", "Cancel"];
  pending.planHandoffLabels = labels;
}
\`\`\`

## Risks
- \`plan_text\` can be several KB; the card caps height at ~50vh and scrolls.
- The default-facet sentinel is \`"execute"\`; a different default would show the
  badge spuriously.

Once approved, the chosen label round-trips to a \`plan_handoff_answer\` decision
via the reverse mapping in \`ui-bridge.ts\` (no change needed there).`;
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "plan",
          requestId: "req-plan-handoff-1",
          title: "Plan handoff",
          planText,
          displayPath: "plan.md",
          targetFacet: "execute",
          actionLabels: [
            "Implement (new context)",
            "Implement (current context)",
            "Cancel",
          ],
        },
      },
    },
  ];
}

/** A plan-handoff card with a SHORT timeout so the deny-safe autoResolve path
 *  fires: a timed-out `plan` dialog must send the Cancel label (a typed
 *  plan_handoff_answer), not the universal {cancelled}. Drives the e2e timeout
 *  test. Mirrors `timeoutConfirm()`. */
export function planHandoffTimeout(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "plan",
          requestId: "req-plan-handoff-timeout-1",
          title: "Plan handoff (timed)",
          planText: "A short plan that will auto-dismiss on timeout.",
          displayPath: "plan.md",
          targetFacet: "execute",
          actionLabels: [
            "Implement (new context)",
            "Implement (current context)",
            "Cancel",
          ],
          timeoutMs: 1200,
        },
      },
    },
  ];
}

/** A permission approval popup that surfaces the tool name + input preview and
 *  a PRUNED option list (keep_targets=[session] → Deny + Allow once + Allow for
 *  session only). Mirrors what the real daemon sends (permission_tool_call +
 *  permission_candidate_rule) so e2e + screenshots exercise the new card.
 *  Uses the shared `pruneApprovalOptions` helper so the pruning logic can't
 *  drift from the forward mapping. */
export function permissionDialog(): ScriptStep[] {
  const keepTargets = ["session"] as const;
  const choices = pruneApprovalOptions(keepTargets);
  const options = choices
    .map((choice) => PERMISSION_APPROVAL_CHOICES.indexOf(choice))
    .map((i) => PERMISSION_APPROVAL_LABELS[i])
    .filter((l): l is string => !!l);
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "permission",
          requestId: "req-permission-1",
          title: "Run bash?",
          toolName: "shell_exec",
          toolInput: JSON.stringify({ command: "rm -rf /tmp/test" }, null, 2),
          options,
        },
      },
    },
  ];
}

/** Drives the facet badge (now in the composer toolbar): emits a sessionUpdated
 *  snapshot carrying `facet: "plan"` so the badge shows the accent-tinted "Plan"
 *  state, dwells long enough to assert it, then emits a snapshot with
 *  `facet: "execute"` so the badge reverts to the subtle "Execute" chip (the badge
 *  is always visible — a state readout, not a toggle that hides). Exercises the
 *  full snapshot→foldEvent→state.facet→UI path (the critical data path). */
export function planFacet(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ facet: "plan", status: "idle" }),
      },
    },
    {
      // Dwell so the badge is stable on capture, then revert to execute (badge → "Execute").
      wait: 1500,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ facet: "execute", status: "idle" }),
      },
    },
  ];
}

/** Drives the PlanView overlay: emits a sessionUpdated snapshot carrying
 *  `facet: "plan"` + `activePlan` (a short markdown plan), so the Plan button
 *  appears in the StatusHeader and the overlay can be opened. Exercises the full
 *  snapshot→foldEvent→state.activePlan→UI path. */
export function planView(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({
          facet: "plan",
          activePlan: PLAN_VIEW_TEXT,
          status: "idle",
        }),
      },
    },
  ];
}

/** Drives the StatusHeader goal badge: emits a sessionUpdated snapshot carrying
 *  `goal` (a GoalInfo with a summary + lifecycle), so the GoalBadge renders in
 *  the subtitle. Exercises the full snapshot→foldEvent→state.goal→UI path. */
export function goalActive(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({
          goal: { summary: "Ship the goal badge feature", lifecycle: "active" },
          status: "idle",
        }),
      },
    },
  ];
}

/** Clears the goal badge: emits a sessionUpdated snapshot carrying `goal: null`,
 *  so the fold clears state.goal and the GoalBadge hides. Exercises the cleared
 *  data path (null → undefined in the fold). */
export function goalClear(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ goal: null, status: "idle" }),
      },
    },
  ];
}

/** Drives the RightSidebar: emits a sessionUpdated snapshot carrying sample
 *  flagged files + todos, so the right-sidebar panel shows live session context.
 *  Exercises the full snapshot→foldEvent→state.flags/todos→UI path. */
export function contextPanel(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({
          flags: [
            { path: "src/app.ts", mode: "included" },
            { path: "src/lib/store.svelte.ts", mode: "included" },
            { path: "README.md", mode: "referenced" },
          ],
          todos: [
            {
              id: 1,
              title: "Wire up the right sidebar",
              description: "Add protocol types, event-map threading, and the drawer component",
              status: "in_progress",
              dependencies: [],
            },
            {
              id: 2,
              title: "Add e2e tests",
              description: "Assert flagged files + todos render, toggle opens/closes",
              status: "pending",
              dependencies: [1],
            },
            {
              id: 3,
              title: "Review with subagent",
              description: "Check type safety, overwrite-guard consistency, tooltips",
              status: "pending",
              dependencies: [2],
            },
          ],
          status: "idle",
        }),
      },
    },
  ];
}

/** A short markdown plan used by the planView fixture. */
const PLAN_VIEW_TEXT = `# Plan: Wire up the plan overlay

## Steps
1. Add \`activePlan\` to the SessionSnapshot protocol
2. Thread \`active_plan\` through the event-map
3. Build the PlanView modal + StatusHeader button

## Notes
- The overlay is read-only — no editing from inside it
- Renders via Markdown.svelte (same as the plan-handoff card)
`;

/** A newly-created session that is still WARMING UP: it surfaces in the `initializing`
 *  phase (model load / history replay / trust resolution), dwells there long enough to
 *  screenshot the distinct spinner, then transitions to idle once "ready". Drives the
 *  sidebar row + header "spinning up" indicator deterministically (dev bar `initializing`,
 *  e2e). The dwell is a script `wait`, so the rendered state is stable on capture. */
export function initializingSession(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionOpened",
        snapshot: snapshot({ status: "initializing" }),
      },
    },
    {
      // After warm-up, the session settles to idle (ready for the first prompt).
      wait: 1200,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  ];
}

/** Reproduces the journal-nudge interaction (the auto-collapse bug). A normal turn
 *  (prompt → work → final response → runCompleted) is followed by an extension-injected
 *  custom message (`customMessage`, display:true) that triggers a SECOND run: the
 *  journal call + a short reply. Without the turn-boundary split this would collapse
 *  the first turn's real final response into the nudge run's "work" block. With the
 *  fix, turn 1 keeps its response visible and the nudge heads its own collapsible turn
 *  (a tiny expandable pill). Drives the dev-bar `journalnudge` button + e2e. */
export function journalNudge(): ScriptStep[] {
  const steps: ScriptStep[] = [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: "u-jn-1",
        text: "Rename the helper and update its callers.",
      },
    },
  ];
  advanceTs(12_000);
  steps.push(
    ...deltas(
      "I'll rename it and fix the call sites. Let me find them first.",
      "text",
    ),
    ...toolSpan(
      {
        callId: "jn-t1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: 'rg -n "oldHelper" src' },
      },
      {
        callId: "jn-t1",
        success: true,
        output: "src/a.ts:4:  oldHelper()\nsrc/b.ts:9:  oldHelper()",
      },
      { startWait: 100, wait: 200, durationMs: 380 },
    ),
    // The REAL turn-final response. This is the paragraph that used to get swallowed.
    ...deltas(
      "Done — renamed `oldHelper` to `resolveHelper` and updated both call sites in `a.ts` and `b.ts`.",
      "text",
    ),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  );
  // The extension fires on agent_end and injects a nudge, triggering a fresh run.
  advanceTs(400);
  steps.push(
    {
      wait: 120,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "customMessage",
        id: "inject-jn-1",
        customType: "journal-nudge",
        text:
          "<journal-nudge>this turn did work and didn't journal. if a fork or " +
          "correction formed that's generally applicable AND isn't already in your " +
          "skills/AGENTS.md, call the journal skill now.</journal-nudge>",
        display: true,
      },
    },
  );
  advanceTs(2_000);
  steps.push(
    ...toolSpan(
      {
        callId: "jn-t2",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: {
          command:
            './skills/journal/scripts/journal observation "prefer X over Y"',
        },
      },
      { callId: "jn-t2", success: true, output: "journal entry staged" },
      { startWait: 120, wait: 220, durationMs: 520 },
    ),
    ...deltas("Journaled a note about the helper-naming convention.", "text"),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
      },
    },
  );
  return steps;
}

/** A turn that asks via the `answer` tool, then keeps working. The answer-result card
 *  (QnaResult) must sit in its CHRONOLOGICAL place — between the pre-answer work run and
 *  the post-answer one — not floated to the bottom of the work block, and centered at the
 *  reading measure like every other card (not hugging the wide track's left edge). Drives
 *  the dev-bar `answercard` button + the answer-card e2e. */
export function answerCard(): ScriptStep[] {
  const steps: ScriptStep[] = [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: "ac-u1",
        text: "Strip the unused dep and regenerate the lockfile.",
        entryId: "e-ac-u1",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Let me check what's currently declared first.", "text"),
    ...toolSpan(
      {
        callId: "ac-t1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: 'rg -n "unused-pkg" server/package.json' },
      },
      {
        callId: "ac-t1",
        success: true,
        output: '"unused-pkg": "^1.2.3"',
      },
      { startWait: 120, wait: 220, durationMs: 900 },
    ),
    // The answer tool: its output is the answer extension's formatQnA text, parsed by
    // QnaResult back into the Q/A card.
    ...toolSpan(
      {
        callId: "ac-t2",
        toolName: "answer",
        label: "Ask the operator",
        description: "Ask one or more multiple-choice questions",
        input: {
          questions: [
            {
              question:
                "How do you want to proceed with removing the unused-pkg dependency?",
            },
          ],
        },
      },
      {
        callId: "ac-t2",
        success: true,
        output:
          "Q: How do you want to proceed with removing the unused-pkg dependency?\n" +
          "> The dep is declared in server/package.json and pulled transitively elsewhere; removing it needs the manifest edit + a lockfile regenerate.\n" +
          "A: Drop the line from server/package.json, then run bun install to regenerate the lockfile, then run the full gate and commit",
      },
      { startWait: 120, wait: 220, durationMs: 0 },
    ),
    // Post-answer work: this used to render ABOVE the answer card (pulled out of work),
    // shoving it down as it streamed in. With lanes it lands BELOW the pinned card.
    ...deltas(
      "Removed the line from server/package.json. Regenerating the lockfile.",
      "text",
    ),
    ...toolSpan(
      {
        callId: "ac-t3",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: "bun install 2>&1 | tail -4" },
      },
      {
        callId: "ac-t3",
        success: true,
        output: "lockfile regenerated, no transitive holdouts ✓",
      },
      { startWait: 120, wait: 220, durationMs: 830 },
    ),
    ...deltas(
      "Done — dep dropped, lockfile regenerated, the gate is green.",
      "text",
    ),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
        userEntryId: "e-ac-u1",
        assistantEntryId: "e-ac-a1",
      },
    },
  ];
  return steps;
}

/** The docs/TODO.md repro: an assistant lead-up paragraph immediately precedes the
 *  `answer` tool (no intervening tool call), then the agent keeps working after the
 *  reply. Without the keep-visible peel, that lead-up paragraph is the trailing item of
 *  the pre-answer work run and folds into "Worked for Ns" — hiding the question's
 *  context directly above the Q&A card. Drives the dev-bar `answerleadup` button. */
export function answerLeadUpCard(): ScriptStep[] {
  const steps: ScriptStep[] = [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: "alu-u1",
        text: "Ship the dep removal. Anything I should decide before you commit?",
        entryId: "e-alu-u1",
      },
    },
    {
      wait: 0,
      event: {
        ...base(),
        type: "sessionUpdated",
        snapshot: snapshot({ status: "running" }),
      },
    },
    ...deltas("Let me check what's currently declared first.", "text"),
    ...toolSpan(
      {
        callId: "alu-t1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: 'rg -n "unused-pkg" server/package.json' },
      },
      {
        callId: "alu-t1",
        success: true,
        output: '"unused-pkg": "^1.2.3"',
      },
      { startWait: 120, wait: 220, durationMs: 900 },
    ),
    // The lead-up paragraph — immediately before the answer tool, no tool between them.
    // This is the item the keep-visible peel must lift out of the work run.
    ...deltas(
      "The removal is straightforward, but there's one call to make: the dep is also pulled transitively by a dev-only package, so I can either drop the manifest line and let the transitive copy resolve on its own, or pin an explicit override so the transitive copy disappears too. Dropping is faster but leaves the transitive copy; pinning is cleaner but needs a bunfig override. How do you want to proceed?",
      "text",
    ),
    // The answer tool fires right after the lead-up paragraph.
    ...toolSpan(
      {
        callId: "alu-t2",
        toolName: "answer",
        label: "Ask the operator",
        description: "Ask one or more multiple-choice questions",
        input: {
          questions: [
            {
              question:
                "How do you want to handle the transitive copy of unused-pkg?",
              options: [
                { label: "Drop the manifest line only" },
                { label: "Drop + pin a bunfig override" },
              ],
            },
          ],
        },
      },
      {
        callId: "alu-t2",
        success: true,
        output:
          "Q: How do you want to handle the transitive copy of unused-pkg?\n" +
          "Options:\n  [x] Drop the manifest line only\n  [ ] Drop + pin a bunfig override\n" +
          "A: Drop the manifest line only",
      },
      { startWait: 120, wait: 220, durationMs: 0 },
    ),
    // Post-answer work: the agent resumes in the same turn.
    ...deltas("Dropping the manifest line and regenerating now.", "text"),
    ...toolSpan(
      {
        callId: "alu-t3",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: "bun install 2>&1 | tail -4" },
      },
      {
        callId: "alu-t3",
        success: true,
        output: "lockfile regenerated, transitive copy resolves ✓",
      },
      { startWait: 120, wait: 220, durationMs: 830 },
    ),
    ...deltas(
      "Done — dep dropped, lockfile regenerated, the gate is green.",
      "text",
    ),
    {
      wait: 60,
      event: {
        ...base(),
        type: "runCompleted",
        snapshot: snapshot({ status: "idle" }),
        userEntryId: "e-alu-u1",
        assistantEntryId: "e-alu-a1",
      },
    },
  ];
  return steps;
}

export const SCRIPTS: Record<string, () => ScriptStep[]> = {
  greeting,
  answercard: answerCard,
  answerleadup: answerLeadUpCard,
  journalnudge: journalNudge,
  skill: skillLoad,
  confirm: confirmDialog,
  goal: goalProposal,
  unknown: unknownInterrogative,
  input: inputDialog,
  qna: qnaDialog,
  ambient,
  compat,
  error: errorRun,
  bgrun: bgRun,
  bgwait: bgWait,
  editdiff: editDiff,
  idle: idleNoComplete,
  initializing: initializingSession,
  staleidle: staleIdle,
  pendinghold: pendingHold,
  timeout: timeoutConfirm,
  yesno: yesNoSelect,
  planview: planView,
  goalactive: goalActive,
  goalclear: goalClear,
  context: contextPanel,
};

// --- Session listing + switching (Increment 2) ------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Real wall-clock timestamps (ISO) so the client-side staleness filter
 *  (`Date.now() - updatedAt > 7d`) is exercised deterministically: "recent" rows are
 *  minutes/hours old, the stale one is 10 days old. Computed once at module load — the
 *  mock's determinism is about event *order*, not the list's wall-clock metadata. */
const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

/** The sessions the mock offers in the picker. `demo-session` is the one the
 *  greeting fixture loads, so it's the active row on a fresh server. The last two
 *  exist to exercise the archive + staleness filter: one archived (hidden under the
 *  active-only filter), one untouched >7 days and alone in its project (so its whole
 *  group collapses out of the active view). */
export const SESSION_LIST: SessionListEntry[] = [
  {
    sessionId: "demo-session",
    path: "/sessions/demo-session.jsonl",
    cwd: WORKSPACE.path,
    displayName: "Wire up the WebSocket bridge",
    preview: "Add a /health route to the server and a smoke test for it.",
    userMessageCount: 3,
    // The active fixture session is "loaded", so it carries a context gauge.
    usage: MOCK_USAGE,
    updatedAt: isoAgo(5 * 60_000),
    createdAt: isoAgo(2 * DAY_MS),
    // The operator's last prompt landed just before the agent's last activity.
    lastUserMessageAt: isoAgo(6 * 60_000),
    archived: false,
  },
  {
    sessionId: "older-session",
    path: "/sessions/older-session.jsonl",
    cwd: WORKSPACE.path,
    displayName: "Explore the fold reducer",
    preview: "How does foldEvent assemble the transcript?",
    userMessageCount: 5,
    // A second loaded session, deep into its window — drives the hot-color ring.
    usage: MOCK_USAGE_HIGH,
    updatedAt: isoAgo(2 * 60 * 60_000),
    createdAt: isoAgo(3 * DAY_MS),
    lastUserMessageAt: isoAgo(2 * 60 * 60_000 + 60_000),
    archived: false,
  },
  {
    sessionId: "scratch-session",
    path: "/sessions/scratch-session.jsonl",
    cwd: "/Users/timo/src/scratch",
    preview: "quick scratch session",
    // No usage: this session isn't loaded, so the sidebar shows no ring for it.
    userMessageCount: 1,
    updatedAt: isoAgo(6 * 60 * 60_000),
    createdAt: isoAgo(4 * DAY_MS),
    lastUserMessageAt: isoAgo(6 * 60 * 60_000 + 60_000),
    archived: false,
  },
  {
    sessionId: "archived-session",
    path: "/sessions/archived-session.jsonl",
    cwd: WORKSPACE.path,
    displayName: "Archived experiment",
    preview: "An old experiment I tucked away.",
    userMessageCount: 4,
    updatedAt: isoAgo(60 * 60_000),
    createdAt: isoAgo(5 * DAY_MS),
    lastUserMessageAt: isoAgo(60 * 60_000 + 60_000),
    archived: true,
  },
  {
    sessionId: "stale-session",
    path: "/sessions/stale-session.jsonl",
    cwd: "/Users/timo/src/stale-proj",
    displayName: "Old spike",
    preview: "A spike from a couple of weeks ago.",
    userMessageCount: 2,
    updatedAt: isoAgo(10 * DAY_MS),
    createdAt: isoAgo(12 * DAY_MS),
    lastUserMessageAt: isoAgo(10 * DAY_MS),
    archived: false,
  },
];

function sessionRefFor(sessionId: string): SessionRef {
  return { workspaceId: WORKSPACE.workspaceId, sessionId };
}

/** A flat, instant (no-delay) transcript seed for a session — what `openSession`
 *  returns and the hub folds into fresh state. */
function sessionSeed(
  sessionId: string,
  title: string,
  userText: string,
  assistantText: string,
): SessionDriverEvent[] {
  const ref = sessionRefFor(sessionId);
  const b = () => ({ sessionRef: ref, timestamp: ts() });
  const snap = (status: SessionSnapshot["status"]): SessionSnapshot => ({
    ref,
    workspace: WORKSPACE,
    title,
    status,
    updatedAt: ts(),
    config: { provider: "anthropic", modelId: "claude-opus-4-8" },
  });
  return [
    { ...b(), type: "sessionOpened", snapshot: snap("idle") },
    { ...b(), type: "userMessage", id: `u-${sessionId}`, text: userText },
    { ...b(), type: "assistantDelta", text: assistantText, channel: "text" },
    { ...b(), type: "runCompleted", snapshot: snap("idle") },
  ];
}

/** Seed events for opening a given session path (the active-session swap). */
export function mockSessionSeed(path: string): SessionDriverEvent[] {
  switch (path) {
    case "/sessions/demo-session.jsonl":
      return greeting().map((s) => s.event);
    case "/sessions/older-session.jsonl":
      return sessionSeed(
        "older-session",
        "Explore the fold reducer",
        "How does foldEvent assemble the transcript?",
        "It folds each driver event into render-ready items — assistant deltas accumulate into one bubble, tool cards key off callId, and ambient UI lives in keyed maps.",
      );
    case "/sessions/scratch-session.jsonl":
      return sessionSeed(
        "scratch-session",
        "scratch",
        "quick scratch session",
        "Noted — nothing else here.",
      );
    default:
      return sessionSeed(
        "unknown",
        "Session",
        "(opened)",
        "No fixture for this session.",
      );
  }
}

export const NEW_SESSION_ENTRY: SessionListEntry = {
  sessionId: "new-session",
  path: "/sessions/new-session.jsonl",
  cwd: WORKSPACE.path,
  displayName: "New session",
  preview: "",
  userMessageCount: 0,
  updatedAt: isoAgo(0),
  createdAt: isoAgo(0),
  lastUserMessageAt: isoAgo(0),
  archived: false,
};

/** Seed events for a freshly created (empty) session. `cwd`/`config` reflect the
 *  new-session draft's choices (workspace dir + model/thinking) so the mock mirrors
 *  what the real driver returns and e2e can assert the isolated worktree path. */
export function newSessionSeed(
  opts: { cwd?: string; config?: SessionConfig } = {},
): SessionDriverEvent[] {
  const ref = sessionRefFor("new-session");
  const dir = opts.cwd ?? WORKSPACE.path;
  const workspace =
    dir === WORKSPACE.path
      ? WORKSPACE
      : {
          workspaceId: dir,
          path: dir,
          displayName: dir.replace(/\/+$/, "").split("/").pop() || dir,
        };
  return [
    {
      sessionRef: ref,
      timestamp: ts(),
      type: "sessionOpened",
      snapshot: {
        ref,
        workspace,
        title: "New session",
        status: "idle",
        updatedAt: ts(),
        config: opts.config ?? {
          provider: "anthropic",
          modelId: "claude-opus-4-8",
        },
      },
    },
  ];
}

/** The first turn of a freshly created session, streamed under that session's OWN ref
 *  (taken from its seed snapshot) rather than the demo session's. The deferred-creation
 *  flow delivers the first prompt only after the new session is focused, so its turn must
 *  land in the new session's transcript — mirroring the real driver. `userId` ties the
 *  echoed userMessage to the client's promptId so the optimistic "creating" row hands off
 *  to the authoritative one without a flicker. */
export function newSessionReply(
  template: SessionSnapshot,
  userText: string,
  userId: string,
  images?: readonly ImageContent[],
): ScriptStep[] {
  const ref = template.ref;
  const b = () => ({ sessionRef: ref, timestamp: ts() });
  const snap = (status: SessionSnapshot["status"]): SessionSnapshot => ({
    ...template,
    status,
    updatedAt: ts(),
  });
  const reply =
    "On it — the session's up. Let me take a first look at what you asked for.";
  const steps: ScriptStep[] = [
    {
      wait: 0,
      event: {
        ...b(),
        type: "userMessage",
        id: userId,
        text: userText,
        images,
        entryId: `e-${userId}`,
      },
    },
    {
      wait: 0,
      event: { ...b(), type: "sessionUpdated", snapshot: snap("running") },
    },
  ];
  // Stream the reply in a few-word chunks (same cadence as `deltas`, inlined here so the
  // events carry the new session's ref instead of `base()`'s demo ref).
  const words = reply.split(/(\s+)/);
  let buf = "";
  let n = 0;
  for (const w of words) {
    buf += w;
    if (++n % 3 === 0) {
      steps.push({
        wait: 32,
        event: { ...b(), type: "assistantDelta", text: buf, channel: "text" },
      });
      buf = "";
    }
  }
  if (buf)
    steps.push({
      wait: 32,
      event: { ...b(), type: "assistantDelta", text: buf, channel: "text" },
    });
  steps.push({
    wait: 80,
    event: {
      ...b(),
      type: "runCompleted",
      snapshot: snap("idle"),
      userEntryId: `e-${userId}`,
      assistantEntryId: `e-a-${userId}`,
    },
  });
  return steps;
}

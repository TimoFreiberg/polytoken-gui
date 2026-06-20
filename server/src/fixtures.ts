// Deterministic mock-pi fixtures. Each script is an ordered list of timed events
// that the mock driver replays. Same script -> same event order -> same rendered
// pixels, so an agent can screenshot any UI state reproducibly without a live model.

import type {
  CommandInfo,
  FileInfo,
  ModelDefaults,
  ModelOption,
  ProviderInfo,
  SessionConfig,
  SessionDriverEvent,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  SessionUsage,
  TrustRequest,
} from "@pilot/protocol";

/** Thinking levels the mock's models "support" — drives the picker's thinking menu. */
export const MOCK_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

/** A deterministic spread of models for the picker (mirrors pi's provider:model ids).
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
  { path: "server/src/pi/pi-driver.ts", isDirectory: false },
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

/** The mock's starting model selection (matches the greeting snapshot). */
export const MOCK_DEFAULT_CONFIG: SessionConfig = {
  provider: "anthropic",
  modelId: "claude-opus-4-8",
  thinkingLevel: "medium",
  availableThinkingLevels: MOCK_THINKING_LEVELS,
};

/** Providers the mock offers in the Settings panel, covering every auth shape the panel
 *  renders: an OAuth-connected one (sign-out), an OAuth-capable but unconnected one
 *  (sign-in flow), a key-file one (replace/remove), and two unconnected key-capable
 *  ones — so the panel + e2e exercise the full matrix without real credentials. */
export const MOCK_PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude Pro/Max)",
    hasAuth: true,
    authSource: "oauth",
    apiKeySetupSupported: false,
    oauthSupported: true,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    hasAuth: false,
    authSource: "none",
    apiKeySetupSupported: false,
    oauthSupported: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    hasAuth: true,
    authSource: "auth_file",
    apiKeySetupSupported: true,
    oauthSupported: false,
  },
  {
    id: "google",
    name: "Google",
    hasAuth: false,
    authSource: "none",
    apiKeySetupSupported: true,
    oauthSupported: false,
  },
  {
    id: "groq",
    name: "Groq",
    hasAuth: false,
    authSource: "none",
    apiKeySetupSupported: true,
    oauthSupported: false,
  },
];

/** The mock's global model config: defaults for new sessions + favorites subset
 *  (empty = the header picker shows every model). */
export const MOCK_MODEL_DEFAULTS: ModelDefaults = {
  provider: "anthropic",
  modelId: "claude-opus-4-8",
  thinkingLevel: "medium",
  favorites: [],
};

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
        // Mock branch handle: a stable pi-style entry id so the user prompt offers a
        // "branch from this prompt" button (the real driver supplies these from pi).
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

export function promptReply(userText: string, userId?: string): ScriptStep[] {
  const callId = `t-${ts()}`;
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: userId ?? `u-${ts()}`,
        text: userText,
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

// The interactive project-trust card (D12). NOT a ScriptStep — it rides the driver's
// out-of-band trust channel, not the session event stream — so the mock emits it
// directly via emitTrust rather than through play(). Mirrors the five options pi's CLI
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
          // collapsed-pill rendering is exercised by the dev bar + e2e.
          lines: [
            "Open Tasks (3):",
            "  ○ #v23gry: wire up /health route",
            "  ○ #4dhaiz: add a smoke test",
            "  ○ #dyouxr: document the deploy step",
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

/** An extension reaching for a terminal-only capability against pilot's non-tui
 *  host — folds into a warning notice. Mirrors what the real pi driver emits when
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
            "Custom UI is not available in the pilot remote; run pi in a terminal for this workflow.",
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
 *  rename / model change / pi auto-title via `session_info_changed` — taken at an instant
 *  pi's `isStreaming` reads false during a tool gap). The folded `session.status` flips to
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

export const SCRIPTS: Record<string, () => ScriptStep[]> = {
  greeting,
  journalnudge: journalNudge,
  confirm: confirmDialog,
  input: inputDialog,
  qna: qnaDialog,
  ambient,
  compat,
  error: errorRun,
  bgrun: bgRun,
  editdiff: editDiff,
  idle: idleNoComplete,
  initializing: initializingSession,
  staleidle: staleIdle,
  pendinghold: pendingHold,
  timeout: timeoutConfirm,
  yesno: yesNoSelect,
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

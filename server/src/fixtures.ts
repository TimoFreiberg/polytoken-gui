// Deterministic mock-pi fixtures. Each script is an ordered list of timed events
// that the mock driver replays. Same script -> same event order -> same rendered
// pixels, so an agent can screenshot any UI state reproducibly without a live model.

import type {
  ModelDefaults,
  ModelOption,
  ProviderInfo,
  SessionConfig,
  SessionDriverEvent,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  TrustRequest,
} from "@pilot/protocol";

/** Thinking levels the mock's models "support" — drives the picker's thinking menu. */
export const MOCK_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

/** A deterministic spread of models for the picker (mirrors pi's provider:model ids). */
export const MOCK_MODELS: readonly ModelOption[] = [
  {
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    label: "Claude Opus 4.8",
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
  },
  {
    provider: "deepseek",
    modelId: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
  },
  { provider: "openai", modelId: "gpt-5", label: "GPT-5" },
];

/** The mock's starting model selection (matches the greeting snapshot). */
export const MOCK_DEFAULT_CONFIG: SessionConfig = {
  provider: "anthropic",
  modelId: "claude-opus-4-8",
  thinkingLevel: "medium",
  availableThinkingLevels: MOCK_THINKING_LEVELS,
};

/** Providers the mock offers in the Settings panel: two connected (an OAuth one and a
 *  key-file one) and two unconnected key-capable ones, so the panel + e2e can exercise
 *  set/remove without real credentials. */
export const MOCK_PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    hasAuth: true,
    authSource: "oauth",
    apiKeySetupSupported: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    hasAuth: true,
    authSource: "auth_file",
    apiKeySetupSupported: true,
  },
  {
    id: "google",
    name: "Google",
    hasAuth: false,
    authSource: "none",
    apiKeySetupSupported: true,
  },
  {
    id: "groq",
    name: "Groq",
    hasAuth: false,
    authSource: "none",
    apiKeySetupSupported: true,
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

let _ts = 0;
function ts(): string {
  return String(++_ts).padStart(10, "0");
}

export function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ref: SESSION_REF,
    workspace: WORKSPACE,
    title: "Wire up the WebSocket bridge",
    status: "idle",
    updatedAt: ts(),
    config: MOCK_DEFAULT_CONFIG,
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

export function greeting(): ScriptStep[] {
  return [
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
        text: "Add a /health route to the server and a smoke test for it.",
      },
    },
    ...deltas(
      "I'll add a lightweight health endpoint and a test that hits it. Let me look at how routes are currently registered.",
      "text",
    ),
    {
      wait: 120,
      event: {
        ...base(),
        type: "toolStarted",
        callId: "t1",
        toolName: "bash",
        label: "Run shell command",
        description: "Execute a command in the workspace shell",
        input: { command: 'rg -n "app.get\\(" server/src' },
      },
    },
    {
      wait: 220,
      event: {
        ...base(),
        type: "toolFinished",
        callId: "t1",
        success: true,
        output:
          "server/src/index.ts:14:  app.get('/', ...)\nserver/src/index.ts:19:  app.get('/debug/state', ...)",
      },
    },
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
      },
    },
  ];
}

// --- The default streamed reply to any prompt -------------------------------

export function promptReply(userText: string): ScriptStep[] {
  const callId = `t-${ts()}`;
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "userMessage",
        id: `u-${ts()}`,
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
    {
      wait: 140,
      event: {
        ...base(),
        type: "toolStarted",
        callId,
        toolName: "read",
        label: "Read file",
        description: "Read a file from the workspace",
        input: { path: "server/src/index.ts" },
      },
    },
    {
      wait: 260,
      event: {
        ...base(),
        type: "toolFinished",
        callId,
        success: true,
        output: "// 42 lines — Bun.serve with WS + /debug/state",
      },
    },
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
          key: "todo",
          lines: ["☑ read routes", "☐ add /health", "☐ write smoke test"],
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

export const SCRIPTS: Record<string, () => ScriptStep[]> = {
  greeting,
  confirm: confirmDialog,
  input: inputDialog,
  ambient,
  error: errorRun,
  bgrun: bgRun,
};

// --- Session listing + switching (Increment 2) ------------------------------

/** The sessions the mock offers in the picker. `demo-session` is the one the
 *  greeting fixture loads, so it's the active row on a fresh server. */
export const SESSION_LIST: SessionListEntry[] = [
  {
    sessionId: "demo-session",
    path: "/sessions/demo-session.jsonl",
    cwd: WORKSPACE.path,
    displayName: "Wire up the WebSocket bridge",
    preview: "Add a /health route to the server and a smoke test for it.",
    messageCount: 6,
    updatedAt: "0000000100",
    createdAt: "0000000001",
  },
  {
    sessionId: "older-session",
    path: "/sessions/older-session.jsonl",
    cwd: WORKSPACE.path,
    displayName: "Explore the fold reducer",
    preview: "How does foldEvent assemble the transcript?",
    messageCount: 12,
    updatedAt: "0000000050",
    createdAt: "0000000002",
  },
  {
    sessionId: "scratch-session",
    path: "/sessions/scratch-session.jsonl",
    cwd: "/Users/timo/src/scratch",
    preview: "quick scratch session",
    messageCount: 2,
    updatedAt: "0000000010",
    createdAt: "0000000003",
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
  messageCount: 0,
  updatedAt: "0000000200",
  createdAt: "0000000200",
};

/** Seed events for a freshly created (empty) session. */
export function newSessionSeed(): SessionDriverEvent[] {
  const ref = sessionRefFor("new-session");
  return [
    {
      sessionRef: ref,
      timestamp: ts(),
      type: "sessionOpened",
      snapshot: {
        ref,
        workspace: WORKSPACE,
        title: "New session",
        status: "idle",
        updatedAt: ts(),
        config: { provider: "anthropic", modelId: "claude-opus-4-8" },
      },
    },
  ];
}

// Deterministic mock-pi fixtures. Each script is an ordered list of timed events
// that the mock driver replays. Same script -> same event order -> same rendered
// pixels, so an agent can screenshot any UI state reproducibly without a live model.

import type {
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
} from "@pilot/protocol";

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
    config: {
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      thinkingLevel: "medium",
    },
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

export function trustDialog(): ScriptStep[] {
  return [
    {
      wait: 0,
      event: {
        ...base(),
        type: "hostUiRequest",
        request: {
          kind: "select",
          requestId: "req-trust-1",
          title: "Trust this folder?",
          options: [
            "Trust this folder",
            "Trust parent folder",
            "Trust for this session only",
            "Don't trust",
            "Don't trust (this session)",
          ],
          timeoutMs: 120000,
        },
      },
    },
  ];
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

export const SCRIPTS: Record<string, () => ScriptStep[]> = {
  greeting,
  confirm: confirmDialog,
  trust: trustDialog,
  input: inputDialog,
  ambient,
  error: errorRun,
};

// Pilot's WS contract types (originally adapted from pi-gui's session-driver).
// This is the normalized, JSON-serializable surface of a daemon session.
// We adopt it as pilot's wire contract; trimmed to what pilot consumes.

export type WorkspaceId = string;
export type SessionId = string;
export type RunId = string;
export type Timestamp = string;

export interface WorkspaceRef {
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly displayName?: string;
}

export interface SessionRef {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
}

/** A session's lifecycle phase.
 *  - `initializing`: created but not yet streaming — warming up (model load, history
 *    replay, trust resolution). A transient pre-first-token phase; the sidebar/header
 *    show a distinct "spinning up" indicator rather than the running pulse.
 *  - `running`: a turn is actively streaming.
 *  - `idle`: settled, awaiting input.
 *  - `failed`: the last run errored. */
export type SessionStatus = "idle" | "initializing" | "running" | "failed";
/** The daemon's per-session permission-monitor mode. Mirrors the daemon's
 *  OpenAPI-generated `PermissionMonitorMode` (server/src/polytoken/wire-types.ts)
 *  — the single source of truth is the daemon spec; this copy is the shared
 *  client/server import. Keep in sync if the daemon adds a mode. */
export type PermissionMonitorMode = "standard" | "bypass" | "bypass_plus" | "autonomous";
export type SessionMessageDeliveryMode = "steer" | "followUp";

/** An image attachment for a user message, as the daemon carries them. Base64-encoded
 *  image data with a MIME type — serializable across the WS wire as plain JSON. */
export interface ImageContent {
  readonly type: "image";
  readonly data: string; // base64
  readonly mimeType: string; // e.g. "image/jpeg", "image/png"
}

export interface SessionQueuedMessage {
  readonly id: string;
  readonly mode: SessionMessageDeliveryMode;
  readonly text: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SessionConfig {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  /** Thinking levels the current model supports — drives the picker's options. */
  readonly availableThinkingLevels?: readonly string[];
}

/** How full the active model's context window is — drives the composer's context
 *  meter. A JSON-safe projection of the daemon's `AgentSession.getContextUsage()`. `tokens`
 *  is the estimated token count currently in context; it's `null` when unknown
 *  (e.g. right after a compaction, until the next assistant response re-grounds it),
 *  in which case `percent` is null too but `contextWindow` (the model's max) is still
 *  known and worth showing. */
export interface SessionUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

/** One selectable model for the per-session model picker (the available set is
 *  broadcast separately from the per-session snapshot; see `modelList`). */
export interface ModelOption {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
  /** Thinking levels this model supports (the daemon's `getSupportedThinkingLevels`). Lets the
   *  new-session draft's effort picker offer accurate options before a session exists —
   *  per-session `availableThinkingLevels` is only known once a model is warm. */
  readonly thinkingLevels?: readonly string[];
}

/** One slash command the composer's typeahead can offer — a JSON-safe projection of
 *  the daemon's `get_commands` (extension commands, prompt templates, skills) or, under the
 *  polytoken driver, the daemon's builtin slash commands. The heavy `sourceInfo`
 *  path metadata is dropped; `source` drives a small origin badge. Commands are
 *  cwd/session-scoped (loaded from the focused session's `.pi`), so the list is
 *  re-broadcast on every session switch — see `commandList`. Execution needs
 *  nothing extra: sending `/name args` as a normal prompt routes through the daemon's
 *  `prompt()` (or polytoken's `/prompt`), which runs extension commands and expands
 *  templates/skills. */
export interface CommandInfo {
  /** Invocation name without the leading slash (e.g. "review", "skill:debug"). */
  readonly name: string;
  readonly description?: string;
  /** Origin of the command — drives a small badge in the slash menu. `"builtin"` is
   *  the polytoken driver's daemon-native commands; the other three are the daemon's sources. */
  readonly source: "extension" | "prompt" | "skill" | "builtin";
  /** Usage hint shown after the name (prompt templates only), e.g. "[path]". */
  readonly argumentHint?: string;
}

/** One agent extension, projected JSON-safe for the Settings "Extensions" view — a DOM-free
 *  reduction of the daemon's `Extension` (the heavy `handlers`/`tools` Maps dropped to counts).
 *  LOADED (enabled) extensions come from the daemon's `resourceLoader.getExtensions()`; a DISABLED
 *  one is reconstructed from the `-<resolvedPath>` force-exclude override pilot wrote to
 *  the daemon's settings — it isn't loaded, so it carries no counts. `resolvedPath` is the stable
 *  id AND the toggle key (it's exactly what the override pattern matches). Broadcast as
 *  {@link extensionList}; see {@link setExtensionEnabled}. */
export interface ExtensionInfo {
  /** Absolute resolved path of the extension entry file — the stable id + toggle key. */
  readonly resolvedPath: string;
  /** Display name — the basename of the source path (e.g. "answer.ts"). */
  readonly name: string;
  /** Where it came from: "user" / "project" (the daemon's source scope), with " · package" when
   *  it's a published package rather than a top-level local file. Display-only. */
  readonly source: string;
  /** Whether it's currently enabled (loaded). A disabled row is one pilot force-excluded;
   *  toggling persists and applies on the session's NEXT start (the daemon loads at start). */
  readonly enabled: boolean;
  /** Tools this extension registers (loaded extensions only; 0 when disabled/errored). */
  readonly toolCount: number;
  /** Slash commands it registers (loaded only). */
  readonly commandCount: number;
  /** A short, human-readable description of what this extension does. Currently only
   *  pilot-OWNED extensions carry one (parsed from the file's `@pilot` frontmatter, D3);
   *  user/project/package extensions leave it undefined until the daemon grows the field.
   *  Display-only. */
  readonly description?: string;
  /** A load error the daemon reported for this extension, if any — drives the problems styling. */
  readonly error?: string;
}

/** One file in the composer's @-file mention autocomplete — a relative path from the
 *  session's cwd. The server builds a capped, .gitignore-aware index via `fd` and pushes
 *  it on session switch ({@link fileIndex}); the client fuzzy-matches it locally and
 *  renders the menu, falling back to a server `fd` search ({@link fileList}) only when the
 *  index was truncated. See {@link fileIndex}. */
export interface FileInfo {
  /** Relative path from the session cwd (forward slashes). */
  readonly path: string;
  /** Whether the entry is a directory (the menu renders a trailing "/"). */
  readonly isDirectory: boolean;
}

/** Coarse category for a session-tree node — drives the tree view's filtering, preview
 *  styling, and the row icon/colour. A flat projection of the daemon's `SessionEntry.type` (with
 *  the message role folded in) so the client can filter without re-deriving roles. */
export type TreeNodeKind =
  | "user"
  | "assistant"
  | "tool"
  | "bash"
  | "branch-summary"
  | "compaction"
  | "model-change"
  | "thinking-change"
  | "label"
  | "session-info"
  | "custom";

/** One node of a session's branch tree — a JSON-safe, DOM-free projection of the daemon's
 *  `SessionTreeNode`/`SessionEntry` (the heavy message payload reduced to a one-line
 *  `preview`, projected server-side so `protocol/` stays runtime-free). `id` is the same
 *  handle the `branch` client message takes, so selecting a node needs no extra lookup.
 *  The client rebuilds the tree from `parentId` and marks the active path from the
 *  snapshot's `leafId`. See {@link TreeSnapshot} / {@link treeState}. */
export interface TreeNodeInfo {
  readonly id: string;
  /** Parent node id; null for a root (the opening message, or an alternate opening
   *  message after a re-edit of the very first prompt). */
  readonly parentId: string | null;
  readonly kind: TreeNodeKind;
  /** One-line, whitespace-normalised preview (projected server-side). Empty for an
   *  assistant turn that produced only tool calls — the client hides those by default. */
  readonly preview: string;
  /** ISO timestamp of the entry — siblings render oldest-first, matching the daemon. */
  readonly ts?: string;
  /** A user-assigned label for this node, if any (the daemon's tree labels). */
  readonly label?: string;
}

/** A session's whole branch tree plus its active tip — the payload of {@link treeState}.
 *  `nodes` is the full DAG (every entry, all branches including abandoned ones); the
 *  client filters/flattens it. `leafId` is the current leaf (the active root→leaf path
 *  ends there); null for an empty session. */
export interface TreeSnapshot {
  readonly nodes: readonly TreeNodeInfo[];
  readonly leafId: string | null;
}

/** A model provider pilot can manage credentials for. No secret ever crosses the
 *  wire — only whether it's authed and where that auth comes from, so the UI can
 *  style remove-vs-readonly. Broadcast as `providerList`. */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly hasAuth: boolean;
  /** Where the working credential lives: "auth_file" = a key pilot saved and can
   *  remove; "env"/"external" = configured outside pilot (env var, models.json) and
   *  read-only here; "oauth" = an OAuth token; "none" = unauthed. */
  readonly authSource: "none" | "oauth" | "auth_file" | "env" | "external";
  /** Whether pilot can set a plain API key for this provider (the daemon's curated set). */
  readonly apiKeySetupSupported: boolean;
  /** Whether pilot can start an OAuth sign-in for this provider (it's in the daemon's OAuth
   *  registry — Anthropic Claude Pro/Max, OpenAI Codex, GitHub Copilot). Drives the
   *  "Sign in" button; `authSource === "oauth"` means already signed in, so offer
   *  sign-out instead. */
  readonly oauthSupported: boolean;
}

// --- OAuth provider login (global + interactive, like the trust channel) ---
// Sign-in is a global action (it writes the daemon's shared auth.json, not a session), so it
// travels its own wire messages rather than the session-scoped Host UI / event stream.
// The flow can be remote: the daemon opens an authorize URL the operator loads on their phone,
// then they paste the resulting code/redirect-URL back — no callback reachable over
// Tailscale needed (the daemon's loginAnthropic races a localhost loopback against this paste).

/** One option in an OAuth `select` step (e.g. browser vs device-code login method). */
export interface OAuthSelectOption {
  readonly id: string;
  readonly label: string;
}

/** One interactive step in an OAuth login the operator must answer. Surfaced by the
 *  server during {@link PilotDriver.oauthLogin}; the client renders it and sends the
 *  answer back via the `oauthRespond` client message. */
export interface OAuthLoginPrompt {
  /** "input": free text — paste an authorization code or the full redirect URL.
   *  "select": choose one of `options` (the answer is the chosen option's id). */
  readonly kind: "input" | "select";
  readonly message: string;
  readonly placeholder?: string;
  /** The authorize URL to open in a browser. Present on the first step of a browser
   *  flow — open it, complete login, paste the code back. Absent on follow-up steps. */
  readonly url?: string;
  readonly instructions?: string;
  /** Present for `kind: "select"`. */
  readonly options?: readonly OAuthSelectOption[];
}

/** A device-code prompt (OpenAI Codex / GitHub Copilot device flow): show the user code
 *  + verification URL. The login completes by background polling, so there's no value to
 *  send back — it's informational. */
export interface OAuthDeviceInfo {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds?: number;
}

/** Pilot's view of the daemon's GLOBAL model config (not per-session): the default new
 *  sessions start from, plus the favorites subset the header picker is filtered to.
 *  `favorites` are concrete `provider:modelId` refs (resolved server-side from the daemon's
 *  glob-capable `enabledModels` patterns); empty = no filter, show every model.
 *  Broadcast as `modelDefaults`. */
export interface ModelDefaults {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly favorites: readonly string[];
}

/** A projection of the daemon's CurrentGoal for display. Only the fields
 *  the UI needs; the full daemon schema (timestamps, continuation count,
 *  file paths) is trimmed to keep the wire lightweight. */
export interface GoalInfo {
  /** Short, human-readable summary of the goal. */
  readonly summary: string;
  /** Lifecycle state: "active" | "paused" | "blocked" | "complete" (open set). */
  readonly lifecycle: string;
}

export interface SessionSnapshot {
  readonly ref: SessionRef;
  readonly workspace: WorkspaceRef;
  readonly title: string;
  readonly status: SessionStatus;
  readonly updatedAt: Timestamp;
  readonly archivedAt?: Timestamp;
  readonly preview?: string;
  readonly config?: SessionConfig;
  /** Context-window fill at the moment the snapshot was taken. Recomputed at turn
   *  boundaries + on model/thinking change, not per streamed delta. */
  readonly usage?: SessionUsage;
  readonly runningRunId?: RunId;
  readonly queuedMessages?: readonly SessionQueuedMessage[];
  /** The active facet (e.g. "execute", "plan"). Undefined means unknown / default;
   *  the StatusHeader shows a badge only when this is set and not "execute". */
  readonly facet?: string;
  /** The active permission-monitor mode ("standard" | "bypass" | "autonomous").
   *  Undefined means unknown (not yet seeded). The daemon exposes only the live
   *  per-session monitor, not the global config default. */
  readonly permissionMonitor?: PermissionMonitorMode;
  /** The active plan document's markdown (set when the plan facet produces a
   *  plan). Undefined means no plan exists / the facet isn't "plan". */
  readonly activePlan?: string;
  /** The active saved-session goal; undefined means the snapshot didn't carry
   *  it (older daemon — preserve existing state); null means explicitly cleared;
   *  a GoalInfo object means set. Same overwrite-guarded semantics as `facet`,
   *  extended with a null/cleared state (the daemon's `current_goal` is
   *  `null | CurrentGoal | undefined`, unlike `active_facet` which is just
   *  present-or-absent). Drives the StatusHeader goal badge. */
  readonly goal?: GoalInfo | null;
}

/**
 * One row in the session picker — a JSON-safe projection of the daemon's `SessionInfo`
 * (Dates rendered as ISO strings, the heavy `allMessagesText` dropped). `path` (the
 * .jsonl file) is the switch key, since the daemon's resume/open APIs are path-based and the
 * `sessionId`/cwd can be empty for older sessions.
 */
export interface SessionListEntry {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly cwd: string;
  readonly displayName?: string;
  readonly preview: string;
  /** Count of the operator's own turns (messages with role "user") — NOT every
   *  message. the daemon's session files interleave assistant + toolResult messages, so a
   *  raw message count balloons with tool traffic; the sidebar wants "how many times
   *  did I write something", which is this. */
  readonly userMessageCount: number;
  readonly updatedAt: Timestamp;
  readonly createdAt: Timestamp;
  /** When the operator last sent a message here — the timestamp of the last role-"user"
   *  entry in the session, or `createdAt` if none yet. Pilot derives this itself from the
   *  session .jsonl (no daemon change). It's the sidebar's sort key: Claude-app-style "most
   *  recently used on top", but WITHOUT `updatedAt`'s noise — `updatedAt` bumps on every
   *  streamed agent turn, so sorting by it makes running sessions jump around as they
   *  emit tokens; this only moves when you actually send something. */
  readonly lastUserMessageAt: Timestamp;
  readonly parentSessionPath?: string;
  /** Context-window fill, present only for sessions already loaded in memory (the
   *  driver can read it for free from a warm session). Disk-only sessions omit it —
   *  we don't load a session just to show its gauge — so the sidebar shows a ring
   *  only where this is set. */
  readonly usage?: SessionUsage;
  /** Whether the operator has archived this session (pilot-side flag; the driver
   *  resolves it at list time). Archived sessions are hidden by the sidebar's
   *  active-only filter, alongside ones untouched for >7 days. */
  readonly archived: boolean;
  /** Present when this session runs in (or once ran in) a jj/git worktree pilot created
   *  (the cwd is the worktree). The driver resolves it at list time from its worktree
   *  index; the sidebar shows an indicator + a clean-up/copy-path action, and groups the
   *  row under the parent project (`base`) instead of its own worktree-basename group.
   *  Absent for normal sessions and for workspaces pilot didn't create (hand-made jj/git
   *  workspaces keep their own group). */
  readonly worktree?: {
    readonly path: string;
    /** The repo the worktree was forked from — the parent project to group under. */
    readonly base: string;
    /** The jj workspace name (unused for git worktrees). Surfaced for tooltips. */
    readonly name: string;
    /** True once the worktree dir has been reaped (cleaned up / forgotten). The dir no
     *  longer exists, so the live affordances (indicator, copy-path, clean-up) drop —
     *  but `base` is retained so the session keeps grouping under its parent project
     *  instead of jumping into a lonely group named after the dead worktree dir. */
    readonly reaped?: boolean;
  };
}

// --- Host UI (extension interaction) ---

/** One selectable choice in a `qna` question. Mirrors the answer extension's
 *  QuestionOption so the whole form can ride across the bridge structurally. */
export interface QnaQuestionOption {
  readonly label: string;
  readonly description?: string;
}

/** One question in a `qna` form. `options` is the discriminator: absent → a
 *  free-text card; present → a choice card (checkboxes when `multiSelect`,
 *  radios otherwise). Every choice card also offers a free-text "something
 *  else" escape that lands in {@link QnaAnswer.customText}. */
export interface QnaQuestion {
  readonly question: string;
  readonly context?: string;
  readonly options?: readonly QnaQuestionOption[];
  readonly multiSelect?: boolean;
}

/** The answer captured per question. Kept structured (indices + free text)
 *  rather than a pre-formatted string so the extension's `formatQnA` can render
 *  the picked labels and the typed escape exactly as the TUI widget does.
 *  Shapes match the answer extension's `QnAAnswer` — the contract is duck-typed
 *  across the `ctx.ui.qna(...)` seam, not a shared import. */
export interface QnaAnswer {
  /** Indices into the question's `options` the user selected (choice cards). */
  readonly selectedOptionIndices: readonly number[];
  /** Free text the user typed: the whole answer for free-text cards, or the
   *  "something else" escape for choice cards. Empty when unused. */
  readonly customText: string;
}

export type HostUiResponse =
  | { readonly requestId: string; readonly value: string }
  | { readonly requestId: string; readonly confirmed: boolean }
  | { readonly requestId: string; readonly answers: readonly QnaAnswer[] }
  | { readonly requestId: string; readonly cancelled: true };

export type HostUiRequest =
  // BLOCKING dialogs — expect a HostUiResponse
  | {
      readonly kind: "confirm";
      readonly requestId: string;
      readonly title: string;
      readonly message: string;
      readonly defaultValue?: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "input";
      readonly requestId: string;
      readonly title: string;
      readonly placeholder?: string;
      readonly initialValue?: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "select";
      readonly requestId: string;
      readonly title: string;
      readonly options: readonly string[];
      readonly allowMultiple?: boolean;
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "editor";
      readonly requestId: string;
      readonly title: string;
      readonly initialValue?: string;
    }
  | {
      readonly kind: "qna";
      readonly requestId: string;
      /** Optional heading for the whole form (e.g. "A few questions"). */
      readonly title?: string;
      readonly questions: readonly QnaQuestion[];
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "plan";
      readonly requestId: string;
      readonly title: string;
      /** The plan document's markdown body — rendered by Markdown.svelte. Empty when
       *  the daemon sent the interrogative without its context (degraded but not
       *  silent: the body renders blank + the action buttons). */
      readonly planText: string;
      /** Friendly path of the plan doc the operator is approving (display-only). */
      readonly displayPath?: string;
      /** Facet the handoff targets (e.g. "execute"). Display-only context. */
      readonly targetFacet?: string;
      /** The 3 action button labels, in PlanHandoffDecision order:
       *  [implement_new_context, implement_current_context, cancel]. The card
       *  responds with `{value: chosenLabel}` — same shape as `select`. */
      readonly actionLabels: readonly [string, string, string];
      readonly timeoutMs?: number;
    }
  | {
      readonly kind: "permission";
      readonly requestId: string;
      readonly title: string;
      /** The tool being approved (e.g. "shell_exec"). null when the daemon
       *  sent no permission_tool_call context (degraded but not silent). */
      readonly toolName: string | null;
      /** The tool's parsed input, JSON-stringified for display. Truncated to
       *  ~500 chars to bound the card. null when no context. */
      readonly toolInput: string | null;
      /** The pruned approval options, in PERMISSION_APPROVAL_LABELS order.
       *  Always includes "Deny" (index 0) + "Allow once"; grants are pruned
       *  by keep_targets when the daemon provides a candidate rule. */
      readonly options: readonly string[];
      readonly timeoutMs?: number;
    }
  // FIRE-AND-FORGET — ambient UI, no response
  | {
      readonly kind: "notify";
      readonly requestId: string;
      readonly message: string;
      readonly level?: "info" | "warning" | "error";
    }
  | {
      readonly kind: "status";
      readonly requestId: string;
      readonly key: string;
      readonly text?: string;
    }
  | {
      readonly kind: "widget";
      readonly requestId: string;
      readonly key: string;
      readonly lines?: readonly string[];
      readonly placement?: "aboveComposer" | "belowComposer";
    }
  | {
      readonly kind: "title";
      readonly requestId: string;
      readonly title: string;
    }
  | {
      readonly kind: "editorText";
      readonly requestId: string;
      readonly text: string;
    }
  | { readonly kind: "reset"; readonly requestId: string };

export type HostUiDialogKind =
  | "confirm"
  | "input"
  | "select"
  | "editor"
  | "qna"
  | "plan"
  | "permission";

export function isDialogRequest(
  r: HostUiRequest,
): r is Extract<HostUiRequest, { kind: HostUiDialogKind }> {
  return (
    r.kind === "confirm" ||
    r.kind === "input" ||
    r.kind === "select" ||
    r.kind === "editor" ||
    r.kind === "qna" ||
    r.kind === "plan" ||
    r.kind === "permission"
  );
}

// --- Driver event stream ---

export interface SessionEventBase {
  readonly type: string;
  readonly sessionRef: SessionRef;
  readonly timestamp: Timestamp;
  readonly runId?: RunId;
}

export interface SessionOpenedEvent extends SessionEventBase {
  readonly type: "sessionOpened";
  readonly snapshot: SessionSnapshot;
}
export interface SessionUpdatedEvent extends SessionEventBase {
  readonly type: "sessionUpdated";
  readonly snapshot: SessionSnapshot;
}
export interface AssistantDeltaEvent extends SessionEventBase {
  readonly type: "assistantDelta";
  readonly text: string;
  /** pilot extension: distinguish reasoning deltas from answer text */
  readonly channel?: "text" | "thinking";
  /** pilot extension: the daemon's tree entry id for the assistant message this delta belongs
   *  to — the branch handle a "branch from here" button names (see PilotDriver.branchFrom).
   *  Set only on the REPLAY path (history-map), where the persisted entry is known; absent
   *  on the live stream (the daemon doesn't assign the id until the message persists at turn end,
   *  so the live path backfills it via {@link RunCompletedEvent.assistantEntryId}). All
   *  deltas of one assistant message carry the same id. */
  readonly entryId?: string;
}
export interface QueuedMessageStartedEvent extends SessionEventBase {
  readonly type: "queuedMessageStarted";
  readonly message: SessionQueuedMessage;
}
export interface QueueUpdatedEvent extends SessionEventBase {
  /** Complete pending queue after a change. Replaces, rather than patches, folded state. */
  readonly type: "queueUpdated";
  readonly messages: readonly SessionQueuedMessage[];
}
export interface UserMessageEvent extends SessionEventBase {
  // pilot extension: echo the user's submitted prompt into the transcript
  readonly type: "userMessage";
  /** Stable client-generated prompt id on the live path. Reusing it lets the client
   *  reconcile its optimistic row with the authoritative event without a duplicate. */
  readonly id: string;
  readonly text: string;
  readonly images?: readonly ImageContent[];
  /** pilot extension: the daemon's tree entry id for this user prompt — the branch handle a
   *  "branch from this prompt" button names. Set on the REPLAY path (history-map); absent
   *  on the live emit (pilot emits userMessage before the daemon persists the entry), where it's
   *  backfilled via {@link RunCompletedEvent.userEntryId} at turn end. */
  readonly entryId?: string;
}
export interface CustomMessageEvent extends SessionEventBase {
  // An extension-injected `role:"custom"` message (the daemon's `sendMessage`). These trigger
  // a fresh daemon run with no user prompt, so they double as a TURN BOUNDARY: without
  // one, the new run's tools + reply glue onto the prior turn and collapse its final
  // response into the "Worked for Ns" work block. `display` mirrors the daemon's own "show
  // this in the transcript" flag — true ones render as a tiny expandable note, false
  // ones render nothing but still split the turn (the robustness net).
  readonly type: "customMessage";
  readonly id: string;
  readonly customType: string;
  readonly text: string;
  readonly display: boolean;
}
export interface ToolStartedEvent extends SessionEventBase {
  readonly type: "toolStarted";
  readonly toolName: string;
  readonly callId: string;
  readonly input?: unknown;
  /** pilot extension: human label + description resolved from getAllTools() */
  readonly label?: string;
  readonly description?: string;
}
export interface ToolUpdatedEvent extends SessionEventBase {
  readonly type: "toolUpdated";
  readonly callId: string;
  readonly text?: string;
  readonly progress?: number;
}
export interface ToolFinishedEvent extends SessionEventBase {
  readonly type: "toolFinished";
  readonly callId: string;
  readonly success: boolean;
  readonly output?: unknown;
  /** Image content blocks the tool returned (the daemon's `{type:"image"}`), lifted out of
   *  `output` into a typed field so the client renders them without sniffing the raw
   *  result shape — and so the SAME data survives a reload (history-map populates this
   *  too). The base64 lives ONLY here; the live path strips it from `output` to avoid
   *  shipping the bytes twice. */
  readonly images?: readonly ImageContent[];
}
export interface RunCompletedEvent extends SessionEventBase {
  readonly type: "runCompleted";
  readonly snapshot: SessionSnapshot;
  /** pilot extension: the daemon's tree entry ids for the turn that just completed, used to
   *  backfill the branch handle onto the LIVE-streamed transcript (the ids don't exist
   *  until the messages persist at turn end — see AssistantDeltaEvent.entryId). The
   *  reducer stamps `assistantEntryId` onto the turn-final assistant item and
   *  `userEntryId` onto this turn's user item. Absent on the replay path (which threads
   *  ids per-message) and on the mock unless a fixture sets them. */
  readonly userEntryId?: string;
  readonly assistantEntryId?: string;
}
export interface UsageUpdatedEvent extends SessionEventBase {
  // pilot-synthetic: the context-window fill changed mid-turn. Emitted by the hub on a
  // debounced timer while a turn runs, so the composer's context meter climbs live
  // instead of freezing at the last turn-boundary snapshot. Carries ONLY usage — unlike
  // a full sessionUpdated it never touches title/config/queued, so a mid-turn refresh
  // can't clobber them.
  readonly type: "usageUpdated";
  readonly usage: SessionUsage;
}
export interface SessionErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly details?: unknown;
}
export interface RunFailedEvent extends SessionEventBase {
  readonly type: "runFailed";
  readonly error: SessionErrorInfo;
}
export interface HostUiRequestEvent extends SessionEventBase {
  readonly type: "hostUiRequest";
  readonly request: HostUiRequest;
}
export interface HostUiResolvedEvent extends SessionEventBase {
  // pilot-synthetic: a pending dialog settled (a client answered, or the agent
  // auto-resolved on timeout). Emitted by the server, never by the daemon.
  readonly type: "hostUiResolved";
  readonly requestId: string;
}
export interface ExtensionCompatibilityIssue {
  readonly capability: string;
  readonly classification: "terminal-only";
  readonly message: string;
  readonly extensionPath?: string;
  readonly eventName?: string;
}
export interface ExtensionCompatibilityIssueEvent extends SessionEventBase {
  readonly type: "extensionCompatibilityIssue";
  readonly issue: ExtensionCompatibilityIssue;
}
export interface SessionClosedEvent extends SessionEventBase {
  readonly type: "sessionClosed";
  readonly reason: "manual" | "ended" | "failed";
}

export type SessionDriverEvent =
  | SessionOpenedEvent
  | SessionUpdatedEvent
  | AssistantDeltaEvent
  | QueuedMessageStartedEvent
  | QueueUpdatedEvent
  | UserMessageEvent
  | CustomMessageEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolFinishedEvent
  | RunCompletedEvent
  | UsageUpdatedEvent
  | RunFailedEvent
  | HostUiRequestEvent
  | HostUiResolvedEvent
  | ExtensionCompatibilityIssueEvent
  | SessionClosedEvent;

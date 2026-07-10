// Pantoken's WS contract types.
// This is the normalized, JSON-serializable surface of a daemon session.
// We adopt it as pantoken's wire contract; trimmed to what pantoken consumes.

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
 *  OpenAPI-generated `PermissionMonitorMode` (server-rs/pantoken-daemon-types)
 *  — the single source of truth is the daemon spec; this copy is the shared
 *  client/server import. Keep in sync if the daemon adds a mode. */
export type PermissionMonitorMode =
  "standard" | "bypass" | "bypass_plus" | "autonomous";
export type SessionMessageDeliveryMode = "steer" | "followUp";

/** An image attachment for a user message, as the daemon carries them. Base64-encoded
 *  image data with a MIME type — serializable across the WS wire as plain JSON. */
export interface ImageContent {
  readonly type: "image";
  readonly data: string; // base64
  readonly mimeType: string; // e.g. "image/jpeg", "image/png"
}

/** One `@`-reference the daemon resolved out of a prompt's text (file/skill/subagent/
 *  model). `kind` is daemon-defined and open-ended (e.g. "file", "skill", "subagent",
 *  "model") — the client only badges it, never branches on a closed set. `fileKind`
 *  is a file-kind-only subtype (e.g. directory vs regular file); absent for non-file
 *  kinds. Carried on {@link UserMessageEvent} (the live send) and on
 *  {@link SessionQueuedMessage} (a drained queue item, resolved at drain time — see
 *  `PendingTurnInputDrained.resolved_references` in the daemon's OpenAPI schema). */
export interface ResolvedRef {
  readonly kind: string;
  readonly name: string;
  readonly fileKind?: string;
}

export interface SessionQueuedMessage {
  readonly id: string;
  readonly mode: SessionMessageDeliveryMode;
  readonly text: string;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** References the daemon resolved when this item drained into the active turn
   *  (`PendingTurnInputDrained.resolved_references`). Undefined while still queued —
   *  the daemon only resolves refs at drain time, not on initial queueing. */
  readonly references?: readonly ResolvedRef[];
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

/** Connection status of an MCP server, mirroring the daemon's McpServerStatus. */
export type McpServerStatus =
  "connected" | "disconnected" | "reconnecting" | "disabled";

/** Status of a configured MCP server — a JSON-safe projection of the daemon's
 *  `McpServerStatusEntry`. Drives the Settings "MCP" tab. */
export interface McpServerInfo {
  readonly serverName: string;
  readonly status: McpServerStatus;
  readonly toolCount: number;
}

/** Why model discovery did not produce a usable catalog. */
export type ModelCatalogDiagnostic =
  | { readonly kind: "couldNotBeParsed"; readonly message: string }
  | { readonly kind: "emptyOutput"; readonly message: string }
  | { readonly kind: "noResponse"; readonly message: string };

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
/** Pantoken's view of the daemon's GLOBAL model config (not per-session): the default new
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

/** A file the agent flagged as important for this session. JSON-safe projection
 *  of the daemon's FlagEntry (`{path, mode}`). The path is relative to the
 *  session's cwd. `mode` distinguishes files included in context vs referenced. */
export interface FlaggedFile {
  readonly path: string;
  readonly mode: "included" | "referenced";
}

/** A todo item tracked by the agent. JSON-safe projection of the daemon's
 *  TodoSnapshot. `createdAt` threads the daemon's `emitted_at` (ISO datetime)
 *  through; it's when the todo was last emitted (created or updated), not
 *  strictly creation time (R4 in the plan). */
export interface TodoItem {
  /** Stable integer ID (the daemon's todo id). */
  readonly id: number;
  /** Short title. */
  readonly title: string;
  /** Full description text. */
  readonly description: string;
  /** Lifecycle state: pending → in_progress → done, or blocked. */
  readonly status: "pending" | "in_progress" | "done" | "blocked";
  /** IDs of other todos this one depends on. */
  readonly dependencies: readonly number[];
  /** ISO datetime when the todo was last emitted (created or updated). */
  readonly createdAt?: string;
}

/** A background job (subagent or shell) running in the daemon. Projected from
 *  the daemon's `GET /jobs` `JobSnapshot`. The output tail is the primary
 *  summary (condensed output lines); `resultSummary` from `SubagentCompleted`
 *  is a follow-up not included in the MVP. */
export interface BackgroundJob {
  /** The job's handle (e.g. "general-purpose:my-name"). */
  readonly handle: string;
  /** Whether this is a subagent or shell background job. */
  readonly kind: "shell" | "subagent";
  /** Lifecycle state. */
  readonly status:
    "reserved" | "running" | "completed" | "failed" | "cancelled";
  /** The tool name that started the job (e.g. "subagent" or "shell_exec"). */
  readonly toolName: string;
  /** ISO datetime when the job was created. */
  readonly createdAt: string;
  /** ISO datetime when the job ended, if terminal. */
  readonly endedAt?: string;
  /** ISO datetime when the job started running, if started. */
  readonly startedAt?: string;
  /** ISO datetime of the last update. */
  readonly updatedAt: string;
  /** Subagent type (e.g. "general-purpose"), if this is a subagent job. */
  readonly subagentType?: string;
  /** Model override, if any. */
  readonly model?: string;
  /** The subagent's handle, if different from the job handle. */
  readonly subagentHandle?: string;
  /** Whether the job is expiring (about to be reaped). */
  readonly expiring?: boolean;
  /** Condensed output tail (joined from output channels, truncated ~500 chars). */
  readonly outputTail?: string;
  /** Total output bytes across all channels. */
  readonly outputBytes?: number;
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
  /** Whether adventurous auto-handoff is active (the daemon computes: enabled
   *  flag AND the active facet exposes handoff_plan). Undefined means the daemon
   *  didn't carry it (older daemon — preserve existing state). */
  readonly adventurousHandoff?: boolean;
  /** Whether notification auto-drain is enabled. Undefined means the daemon
   *  didn't carry it (older daemon — preserve existing state). */
  readonly notificationAutodrain?: boolean;
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
  /** Flagged files for this session. Undefined means the snapshot didn't carry
   *  them (older daemon — preserve existing state); an array (including empty)
   *  means the daemon reported the current set. Drives the RightSidebar. */
  readonly flags?: readonly FlaggedFile[];
  /** Todos for this session. Same overwrite-guarded semantics as `flags`.
   *  Drives the RightSidebar. Updates on snapshot refresh only (live todo events
   *  are StateDelta, not DaemonEvent — handled in a future iteration). */
  readonly todos?: readonly TodoItem[];
  /** MCP servers for this session. Same overwrite-guarded semantics as `flags`.
   *  Drives the Settings "MCP" tab. Updates on snapshot refresh (lifecycle events
   *  trigger fetchState → re-snapshot). */
  readonly mcpServers?: readonly McpServerInfo[];
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
   *  entry in the session, or `createdAt` if none yet. Pantoken derives this itself from the
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
  /** Whether the operator has archived this session (pantoken-side flag; the driver
   *  resolves it at list time). Archived sessions are hidden by the sidebar's
   *  active-only filter, alongside ones untouched for >7 days. */
  readonly archived: boolean;
  /** Present when this session runs in (or once ran in) a jj/git worktree pantoken created
   *  (the cwd is the worktree). The driver resolves it at list time from its worktree
   *  index; the sidebar shows an indicator + a clean-up/copy-path action, and groups the
   *  row under the parent project (`base`) instead of its own worktree-basename group.
   *  Absent for normal sessions and for workspaces pantoken didn't create (hand-made jj/git
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
  "confirm" | "input" | "select" | "editor" | "qna" | "plan" | "permission";

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
  /** pantoken extension: distinguish reasoning deltas from answer text */
  readonly channel?: "text" | "thinking";
  /** pantoken extension: the daemon's tree entry id for the assistant message this delta belongs
   *  to — the branch handle a "branch from here" button names (see PantokenDriver.branchFrom).
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
  // pantoken extension: echo the user's submitted prompt into the transcript
  readonly type: "userMessage";
  /** Stable client-generated prompt id on the live path. Reusing it lets the client
   *  reconcile its optimistic row with the authoritative event without a duplicate. */
  readonly id: string;
  readonly text: string;
  readonly images?: readonly ImageContent[];
  /** pantoken extension: the daemon's tree entry id for this user prompt — the branch handle a
   *  "branch from this prompt" button names. Set on the REPLAY path (history-map); absent
   *  on the live emit (pantoken emits userMessage before the daemon persists the entry), where it's
   *  backfilled via {@link RunCompletedEvent.userEntryId} at turn end. */
  readonly entryId?: string;
  /** References the daemon resolved out of this prompt's `@`-mentions
   *  (`PromptAccepted.resolved_references`). Undefined when the send went straight into
   *  the pending-turn queue (steer/follow-up) — those resolve later, at drain, and land
   *  on {@link SessionQueuedMessage.references} instead (see `queuedMessageStarted`). */
  readonly references?: readonly ResolvedRef[];
}
export interface CustomMessageEvent extends SessionEventBase {
  // An extension-injected `role:"custom"` message (the daemon's `sendMessage`).
  // `turnBoundary` is true only when this message intentionally starts a new agent
  // turn (currently an explicit goal reminder). It is optional for compatibility with
  // older servers and persisted events; absent means false. `display` controls whether
  // the note is rendered and is independent of turn grouping.
  readonly type: "customMessage";
  readonly id: string;
  readonly customType: string;
  readonly text: string;
  readonly display: boolean;
  readonly turnBoundary?: boolean;
}
export interface ToolStartedEvent extends SessionEventBase {
  readonly type: "toolStarted";
  readonly toolName: string;
  readonly callId: string;
  readonly input?: unknown;
  /** pantoken extension: human label + description resolved from getAllTools() */
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
  /** Marks the tool as interrupted (–) rather than errored (✕). Set only by the
   *  synthetic ToolFinished the seed builder emits for orphaned tool_use blocks
   *  (whose tool_result was lost to a context_cleared); never set on the live path.
   *  Optional + defaults to false for backward compatibility — old clients that
   *  don't read it fall back to error (success:false → error), which is acceptable. */
  readonly interrupted?: boolean;
}
export interface RunCompletedEvent extends SessionEventBase {
  readonly type: "runCompleted";
  readonly snapshot: SessionSnapshot;
  /** pantoken extension: the daemon's tree entry ids for the turn that just completed, used to
   *  backfill the branch handle onto the LIVE-streamed transcript (the ids don't exist
   *  until the messages persist at turn end — see AssistantDeltaEvent.entryId). The
   *  reducer stamps `assistantEntryId` onto the turn-final assistant item and
   *  `userEntryId` onto this turn's user item. Absent on the replay path (which threads
   *  ids per-message) and on the mock unless a fixture sets them. */
  readonly userEntryId?: string;
  readonly assistantEntryId?: string;
}
export interface UsageUpdatedEvent extends SessionEventBase {
  // pantoken-synthetic: the context-window fill changed mid-turn. Emitted by the hub on a
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
  // pantoken-synthetic: a pending dialog settled (a client answered, or the agent
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

/** The session's transcript was truncated or gapped (rewind, /clear,
 *  stream_discontinuity). The hub must RESET the session state — clear the
 *  folded transcript and re-seed from the driver's `defaultSeed()` — because
 *  the fold is additive and naively emitting fresh events would duplicate. */
export interface SessionResetEvent extends SessionEventBase {
  readonly type: "sessionReset";
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
  | SessionClosedEvent
  | SessionResetEvent;

// The client store: holds a reactive SessionState, adopts server snapshots, and
// folds incremental events with the SAME reducer the server runs. Per-client view
// state (composer draft) lives here too and is intentionally never sent upstream.

import {
  type CommandInfo,
  type DirListing,
  type PathStat,
  type FileInfo,
  foldEvent,
  type HostUiResponse,
  type ImageContent,
  initialSessionState,
  type LoginEnvStatus,
  type ModelDefaults,
  type PilotSettings,
  type ModelOption,
  type PermissionMonitorMode,
  type ServerMessage,
  type SessionAttention,
  type SessionConfig,
  type SessionListEntry,
  type SessionState,
  type TranscriptItem,
  type TrustRequest,
} from "@pilot/protocol";
import { clearToken, getToken, setToken } from "./auth.js";
import { notifyNativeUpdateStarting } from "./native-bridge.js";
import { filterSessions } from "./session-filter.js";
import { dedupeConsecutive } from "./prompt-history.js";
import { deliveryState } from "./delivery.js";
import { ensurePermission } from "./notify.js";
import {
  applyThemeMode,
  getThemeMode,
  setThemeMode,
  type ThemeMode,
  watchSystemTheme,
} from "./theme.js";
import {
  applyFontScale,
  getFontScale,
  setFontScale as persistFontScale,
} from "./font-scale.js";
import {
  currentPushState,
  ensurePushSubscription,
  type PushState,
  sendTestPush,
} from "./push.js";
import {
  deletePendingPrompt,
  loadPendingPrompts,
  type PendingPrompt,
  savePendingPrompt,
} from "./prompt-outbox.js";
import {
  connect,
  type ConnectionState,
  connectionState,
  disconnect,
  forceReconnect,
  onMessage,
  send,
} from "./ws.svelte.js";

/** A transient snackbar. `action` is an optional one-shot affordance (e.g. Undo). */
export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

/** A view in the back/forward navigation history (⌘[ / ⌘]): a focused session, or a
 *  pending new-session draft identified by its project cwd. Client-only view state. */
type NavEntry =
  { kind: "session"; sessionId: string } | { kind: "draft"; cwd: string };

function navEntryEquals(a: NavEntry, b: NavEntry): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "session"
    ? a.sessionId === (b as { sessionId: string }).sessionId
    : a.cwd === (b as { cwd: string }).cwd;
}

class PilotStore {
  session = $state<SessionState>(initialSessionState());
  serverId = $state<string | null>(loadLastServerId());
  /** The server's data directory (absolute path), broadcast in `hello`. Shown in Settings
   *  with copy + reveal-in-Finder actions. Empty string until hello arrives (or when the
   *  server didn't provide one — older/mock servers). */
  dataDir = $state("");
  ready = $state(false);
  unauthorized = $state(false);
  /** Why the auth gate is showing, so it can explain itself. "expired" = a token was
   *  rejected mid-session (vs. first-run no-token); "signed-out" = explicit sign-out. */
  unauthorizedReason = $state<"expired" | "signed-out" | null>(null);

  // Session picker — server-authoritative: the sessions on disk + which is active.
  sessions = $state<SessionListEntry[]>([]);
  activeSessionId = $state<string | null>(null);
  // The cwd a bare new session defaults to ($HOME), surfaced by the server in
  // sessionList. Used for the boot landing draft + the new-session placeholder.
  defaultNewSessionCwd = $state("");
  // True once the boot-landing draft has been handled (opened or skipped because a
  // session was already active). Prevents reconnects from re-opening a draft the
  // operator dismissed.
  bootDraftHandled = $state(false);
  // True only while boot is reopening the last session saved for this Pilot server.
  // If the disk entry disappears between list + open, the switch error clears the stale
  // preference and falls back to the normal $HOME draft instead of leaving a blank pane.
  private bootRestoreInFlight = false;
  // The path of the last openSession request — captured so a lease-conflict
  // toast can offer a Retry that re-sends the same openSession(path). Cleared
  // on a successful session switch (snapshot lands → no retry needed).
  private lastAttemptedSessionPath: string | null = null;
  // Reconnect focus recovery. A dropped socket (Tailscale flap on a phone) reconnects as a
  // brand-new connection, which the hub registers focused on the empty landing — so without
  // this you'd be reading a session, the link blips, and the view snaps to a blank pane.
  // `booted` flips true after the first hello; every hello after that is a reconnect, and we
  // stash the session we were viewing in `reconnectFocusId` so the bootstrap session list can
  // re-assert it. (A new-session draft survives a reconnect on its own — it's client state
  // rendered ahead of the snapshot — so it's deliberately not captured.)
  private booted = false;
  private reconnectFocusId: string | null = null;
  // Session ids with a live turn right now (server-pushed via `sessionStatus`).
  runningIds = $state<Set<string>>(new Set());
  // Session ids warming up (created/opened, not yet streaming) — server-pushed in the
  // same `sessionStatus` message. Drives the sidebar/header "spinning up" indicator.
  initializingIds = $state<Set<string>>(new Set());
  // Compact cross-session attention summaries. Background transcripts stay server-side;
  // this is enough to route the operator to activity, approvals, failures, and completions.
  attention = $state<Map<string, SessionAttention>>(new Map());
  attentionVersion = $state(0);
  // Sessions with new content since last viewed. GUI-only, in-memory: a session is
  // marked unread when a *background* turn of it finishes (running→done while it's
  // not the active session); cleared when it becomes active. Everything starts read
  // on page load (no persistence) — matches the TODO's "old sessions default to read".
  unread = $state<Set<string>>(new Set());
  // The ACTIVE session can also be "unread": if the agent appends content while you're
  // scrolled up (so new content sits below the viewport), the row flags unread even
  // though it's focused — the classic "new messages ↓" signal. GUI-only, in-memory;
  // Transcript.svelte sets it ("grew while not at bottom") and clears it on scroll-to-
  // bottom. Distinct from `unread` (which is background sessions only) so switching
  // sessions doesn't entangle the two.
  activeUnread = $state(false);
  // Model picker — the models available to switch to (current selection lives in
  // session.config). Server-authoritative, delivered like `sessions`.
  models = $state<ModelOption[]>([]);
  // Slash commands the focused session offers, for the composer typeahead. Server-
  // authoritative, delivered like `models`; refreshed on session switch (cwd-scoped).
  commands = $state<CommandInfo[]>([]);
  // The focused session's full file index (cwd-scoped), pushed by the server on connect +
  // session switch. The composer fuzzy-matches this locally so the @-mention menu is
  // instant — no per-keystroke round-trip. `truncated` is true when the cwd overflowed the
  // server cap, the only case the composer falls back to a `queryFiles` search.
  fileIndex = $state<{ files: readonly FileInfo[]; truncated: boolean }>({
    files: [],
    truncated: false,
  });
  // Fallback file-search results for the current @-mention query (the server `fd` path,
  // only requested when `fileIndex.truncated`). The server echoes the query so we can drop
  // stale responses; the composer merges these into the local matches. See `queryFiles()`.
  files = $state<{ query: string; items: readonly FileInfo[] }>({
    query: "",
    items: [],
  });
  // New-session directory picker: the server-side listing for the directory it's currently
  // showing (entries are child dir names). The server resolves paths on ITS filesystem, so
  // this browses the server, not the client device. Null until the picker first queries.
  dirListing = $state<DirListing | null>(null);
  // True while a `queryDir` is in flight, for the picker's loading hint.
  dirLoading = $state(false);
  // Inline path validation hint for the dir picker — the most recent stat result for a
  // typed path. Null when no stat is in flight or the path has been cleared.
  pathStat = $state<PathStat | null>(null);
  // Interactive project-trust card (D12). Out-of-band, not part of the folded session
  // state: trust is decided per-cwd before a session exists. Null when none pending.
  trustRequest = $state<TrustRequest | null>(null);
  // Settings panel: the agent's global model defaults + favorites. Server-authoritative,
  // delivered like `models`.
  modelDefaults = $state<ModelDefaults>({ favorites: [] });
  // Pilot-local settings (Settings "Environment" section) + the live status of the
  // server's startup login-shell env capture. Server-authoritative, sent on connect and
  // after a change. `loginEnv.activeShell` is what the running server captured with;
  // compare to `pilotSettings.loginShell` to know whether a restart is pending.
  pilotSettings = $state<PilotSettings>({
    loginShell: null,
    backgroundModel: null,
    enabledExtensions: null,
  });
  loginEnv = $state<LoginEnvStatus>({ activeShell: null, ok: false });
  // Server-computed: the configured login shell differs from the one captured at boot,
  // so a restart is needed to apply it. Drives the Settings "restart to apply" hint.
  loginShellPendingRestart = $state(false);
  // Server-resolved warning for the background-model spec (a bad/unresolvable spec →
  // a non-empty string the Settings "Models" section shows as a loud red error).
  // undefined = unset or resolved cleanly.
  backgroundModelWarning = $state<string | undefined>(undefined);
  // per-client view state — local only (never sent upstream; see D5)
  composerDraft = $state("");
  composerImages = $state<ImageContent[]>([]);
  // Durable client outbox. Entries remain until the server explicitly ACKs the agent's prompt
  // preflight; reconnect/reload resends queued entries by stable promptId.
  pendingPrompts = $state<PendingPrompt[]>([]);
  private hydratedOutboxServerId: string | null = null;
  // Per-session (and per new-session-draft) unsent prompt text, persisted in localStorage
  // so switching sessions — or reloading — preserves whatever you were typing. Keyed by
  // `s:<sessionId>` for an existing session and `n:<cwd>` for a pending new-session draft
  // (up to one per project). The live edit lives in `composerDraft`; this map is the
  // durable backing store, stashed on switch / debounced keystroke / pagehide. Pure client
  // state — no protocol change.
  private draftMap = $state<Record<string, string>>(loadDraftMap());
  // Per new-session-draft config that isn't carried by composerDraft text — the worktree
  // toggle plus any explicit model/thinking override. Keyed identically to draftMap
  // (`n:<cwd>`) so a switch / reload restores it; startDraft rebuilds the draft from defaults
  // and would otherwise drop it. Stores only what diverges from the default (worktree:true,
  // and a model/thinking that isn't the current global default) — absence means "use default".
  private draftConfigMap =
    $state<Record<string, StoredDraftConfig>>(loadDraftConfigMap());
  // Per-session (and per new-session-draft) submit log: every prompt the user has SENT,
  // recorded at the submit chokepoint and persisted in localStorage (key `pilot.promptHistory`).
  // This is the durable, independent backing for ArrowUp recall — independent of the transcript
  // and the outbox on purpose, so a prompt eaten by an API error / a future janky bug is still
  // recallable. Keyed like draftMap (`s:<sessionId>` / `n:<cwd>`). The navigable list merges this
  // with the focused session's transcript user messages (see currentPromptHistory).
  private promptHistory = $state<Record<string, string[]>>(loadPromptHistory());
  // New-session draft (Claude-app style): when non-null the main pane shows the
  // config chips + composer for a session that does NOT exist yet. Creation is
  // deferred — submitDraft() sends `newSession` (cwd/worktree/model/thinking + the
  // first prompt) atomically, so nothing hits the server until the user sends.
  // Convention (docs/DECISIONS.md D17): every field settable here should survive a
  // session switch / reload — persist it via draftConfigMap unless there's a concrete
  // reason it can't be (then add an e2e round-trip in e2e/drafts.e2e.ts).
  draft = $state<{
    cwd: string;
    worktree: boolean;
    model?: { provider: string; modelId: string };
    thinking?: string;
  } | null>(null);
  // A newSession prompt was just submitted and we're awaiting the new session's first
  // authoritative snapshot from the server (session warm-up can take a beat). Holds the
  // submitted prompt (id + content). While set, the transcript renders a fresh/empty
  // session seeded with this first-prompt row + a "Starting session…" indicator — instead
  // of flashing the previously focused session's transcript, which `this.session` still
  // holds until the snapshot swaps it in. Cleared once that prompt's real userMessage
  // lands in the focused transcript (maybeFinishCreating), or on navigation / failure.
  creatingSession = $state<{
    promptId: string;
    text: string;
    images?: ImageContent[];
    createdAt: string;
  } | null>(null);
  // Sidebar open/collapsed. Default open on a roomy viewport, closed on a phone
  // (where it's an overlay drawer). Persisted per-device in localStorage.
  sidebarOpen = $state(initialSidebarOpen());
  // Right sidebar (context panel: flagged files + todos). Default closed — it's
  // contextual, not navigational, so it's opt-in. Not persisted (simpler v1).
  rightSidebarOpen = $state(false);
  // Sidebar filter: false = active only (hide archived + sessions untouched >7d),
  // true = show everything. Per-device, persisted in localStorage; defaults to
  // active-only (the decluttering is the point).
  showArchived = $state(initialShowArchived());
  // Last server-side error worth showing the user (e.g. a session switch to a bad
  // path failed). Transient — cleared on the next successful switch or by the UI.
  lastError = $state<string | null>(null);
  // Transient snackbars (archive undo, "resolved on another device", …). Client-only,
  // never sent upstream; each carries an optional one-shot action and auto-dismisses.
  toasts = $state<Toast[]>([]);
  private toastSeq = 0;
  // Blocking-dialog requestIds this client itself answered, so an echoed `hostUiResolved`
  // for one of them isn't mistaken for a "resolved on another device" event.
  private locallyResolved = new Set<string>();
  // Push subscription status for this device. "working" while a subscribe is in flight.
  pushState = $state<PushState | "working">("idle");
  // Settings panel open/closed — per-client view state, never sent upstream.
  settingsOpen = $state(false);
  // In-transcript find (⌘F) open/closed — per-client view state. The query, matches, and
  // highlight ranges live in TranscriptSearch (DOM-derived, not serializable). `searchFocusN`
  // bumps so a repeated ⌘F re-focuses + selects the existing query, mirroring native find.
  searchOpen = $state(false);
  searchFocusN = $state(0);
  // The PlanView overlay — a modal rendering of the active plan document's
  // markdown. Ephemeral (not persisted); toggled by the StatusHeader button or ⌘P.
  planViewOpen = $state(false);
  // Theme override (system/light/dark), persisted per-device in localStorage.
  themeMode = $state<ThemeMode>(getThemeMode());
  // Hide thinking blocks toggle — when on, thinking content is replaced with a
  // subtle non-expandable placeholder. Persisted per-device in localStorage.
  hideThinking = $state(initialHideThinking());
  // Transcript reading-size multiplier (lib/font-scale.ts; ⌘=/⌘-/⌘0). Persisted per-device.
  fontScale = $state<number>(getFontScale());
  // PWA: a newer service worker installed and is ready; we prompt for a refresh.
  swUpdateReady = $state(false);
  // Desktop app: a new origin/main is staged on the server's clone but deferred because
  // we're connected (server-pushed via `updateStatus`). Drives the sidebar update card;
  // `applying` is true between clicking "update now" and the server restarting. Distinct
  // from `swUpdateReady` (that's the PWA asset-cache refresh).
  appUpdate = $state<{ sha: string; applying: boolean } | null>(null);
  // Desktop app: the running Pilot.app's native shell (`desktop/`) no longer matches the
  // clone's checked-out source, so the binary needs a manual `build-app.sh` rebuild (the TS
  // auto-update can't replace the .app). Server-pushed via `updateStatus`; drives the durable
  // rebuild dot on the sidebar build stamp. Stays false in a plain browser (no stamped app).
  desktopStale = $state(false);
  // Global hotkey dispatch — incremented so $effect catches every keystroke.
  hotkeyAction = $state<{ which: "model" | "thinking"; n: number } | null>(
    null,
  );
  // Bump to ask the composer textarea to retake focus — e.g. after the model/effort
  // menu closes from a keyboard-driven flow. A counter so each request re-fires.
  focusComposerN = $state(0);
  // The most recently selected project's cwd (a session's cwd, or a new-session draft's
  // target). Persisted per-device so ⌘N defaults a fresh draft there even on a cold
  // landing with no session restored. Maintained by setLastProjectCwd.
  lastProjectCwd = $state(loadLastProjectCwd());

  focusComposer(): void {
    this.focusComposerN++;
  }

  // Back/forward navigation history (⌘[ / ⌘]). A stack of views — focused sessions and
  // new-session drafts — in visit order; `navIndex` is the current position. Opening a
  // session or starting a draft truncates any forward entries and appends. Replaying an
  // entry sets `navigating` so the open/startDraft it triggers doesn't re-record the step.
  // Plain fields (no UI reads them yet), never sent upstream.
  private navStack: NavEntry[] = [];
  private navIndex = -1;
  private navigating = false;

  /** Append `entry` as the current view, dropping any forward history. No-op while
   *  replaying a back/forward step, or when it matches the current entry — so reconnect/
   *  boot re-opening the same session never stacks a duplicate. */
  private pushNav(entry: NavEntry): void {
    if (this.navigating) return;
    const cur = this.navStack[this.navIndex];
    if (cur && navEntryEquals(cur, entry)) return;
    this.navStack = [...this.navStack.slice(0, this.navIndex + 1), entry];
    this.navIndex = this.navStack.length - 1;
  }

  /** Show the history entry at `index`, returning whether it could be shown (a session
   *  since deleted can't). Sets `navigating` so the open/startDraft it fires isn't
   *  re-recorded as a fresh step. */
  private applyNav(index: number): boolean {
    const entry = this.navStack[index];
    if (!entry) return false;
    if (entry.kind === "session") {
      const target = this.sessions.find((s) => s.sessionId === entry.sessionId);
      if (!target) return false;
      this.navigating = true;
      try {
        this.openSession(target.path);
      } finally {
        this.navigating = false;
      }
    } else {
      this.navigating = true;
      try {
        this.startDraft(entry.cwd);
      } finally {
        this.navigating = false;
      }
    }
    this.navIndex = index;
    return true;
  }

  /** ⌘[ — step back through visited views, skipping any whose session has vanished. */
  navBack(): void {
    for (let i = this.navIndex - 1; i >= 0; i--) if (this.applyNav(i)) return;
  }
  /** ⌘] — step forward through views revisited after going back. */
  navForward(): void {
    for (let i = this.navIndex + 1; i < this.navStack.length; i++)
      if (this.applyNav(i)) return;
  }

  /** The sessions in the order the sidebar paints them: grouped by project (A→Z),
   *  newest-first within a group, flattened. Honours the active-only filter
   *  (`showArchived`) so cycling visits exactly the rows you can see, but ignores the
   *  sidebar's transient search query — that's component-local view state, and a
   *  keyboard cycle shouldn't depend on whether a search box happens to be filled. */
  get sidebarOrder(): SessionListEntry[] {
    return filterSessions(this.sessions, {
      query: "",
      showArchived: this.showArchived,
      now: Date.now(),
      pinnedIds: this.pinnedSidebarIds,
    }).groups.flatMap((g) => g.items);
  }

  /** Session IDs the sidebar keeps visible even when archived/stale would hide them:
   *  the one currently shown in the transcript, plus every running session. Feeds
   *  `filterSessions`' `pinnedIds` at both callsites (here + the Sidebar component).
   *  The viewed-session pin only holds while it's actually on screen: in a new-session
   *  draft the transcript is replaced by the draft form, so the previously-viewed session
   *  isn't shown and shouldn't be force-kept. This is what lets `setArchived` drop the
   *  focused row — it flips into a draft, and the pin releases. */
  get pinnedSidebarIds(): ReadonlySet<string> {
    const ids = new Set(this.runningIds);
    if (!this.draft) {
      const viewed = this.session.ref?.sessionId ?? this.activeSessionId;
      if (viewed) ids.add(viewed);
    }
    return ids;
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab — step to the next (`dir:1`) or previous (`dir:-1`)
   *  session in sidebar order, wrapping at the ends. From a new-session draft (or any
   *  view whose session isn't in the visible list), it enters the list at the matching
   *  edge: forward → first row, back → last. No-op with nothing to cycle. */
  cycleSession(dir: 1 | -1): void {
    const order = this.sidebarOrder;
    if (order.length === 0) return;
    const currentId = this.session.ref?.sessionId ?? this.activeSessionId;
    const idx = order.findIndex((s) => s.sessionId === currentId);
    const next =
      idx === -1
        ? order[dir > 0 ? 0 : order.length - 1]
        : order[(idx + dir + order.length) % order.length];
    if (next) this.openSession(next.path);
  }

  /** ⌘N — open a new-session draft, defaulting its project to the one you're in (the
   *  focused session's cwd), else the last project you selected, else the server's
   *  default ($HOME). Already drafting → just refocus the composer. */
  newSessionHotkey(): void {
    if (this.draft) {
      this.focusComposer();
      return;
    }
    const viewedId = this.session.ref?.sessionId ?? this.activeSessionId;
    const active = this.sessions.find((s) => s.sessionId === viewedId)?.cwd;
    this.startDraft(active || this.lastProjectCwd || this.defaultNewSessionCwd);
  }

  /** Remember the most recently selected project (a session's cwd, or a draft's target);
   *  persisted per-device so ⌘N's default survives a reload with no session restored. */
  private setLastProjectCwd(cwd: string): void {
    const c = cwd.trim();
    if (!c || c === this.lastProjectCwd) return;
    this.lastProjectCwd = c;
    persistLastProjectCwd(c);
  }

  // Bump to ask the transcript to jump to its bottom. Set whenever the user sends a
  // prompt (the single `enqueuePrompt` chokepoint), so the just-sent message and the
  // incoming reply land in view even if they'd scrolled up reading scrollback — without
  // it, the optimistic bubble appears below the fold behind the "New messages ↓" pill.
  promptSentN = $state(0);

  /** The localStorage key the current composer text belongs to: the new-session draft's
   *  project while drafting, else the focused/active session. */
  private get composerDraftKey(): string {
    if (this.draft) return `n:${this.draft.cwd.trim() || "~"}`;
    const id = this.session.ref?.sessionId ?? this.activeSessionId;
    return id ? `s:${id}` : "none";
  }
  /** Every pending new-session draft worth a sidebar row: the one being actively
   *  composed (its live text is `composerDraft`, not yet stashed) plus any other
   *  project's stashed draft that still has text. Keyed `n:<cwd>` — cwd `~` means
   *  home / no project yet, surfaced as cwd "". Reads `draftMap` + the active draft,
   *  so it reacts to stash / discard / retarget. */
  get pendingDrafts(): {
    key: string;
    cwd: string;
    text: string;
    active: boolean;
  }[] {
    const rows: { key: string; cwd: string; text: string; active: boolean }[] =
      [];
    const activeKey = this.draft ? this.composerDraftKey : null;
    if (this.draft) {
      rows.push({
        key: activeKey!,
        cwd: this.draft.cwd,
        text: this.composerDraft,
        active: true,
      });
    }
    for (const [key, text] of Object.entries(this.draftMap)) {
      // The active draft's live text wins over its (possibly stale) stashed copy.
      if (!key.startsWith("n:") || key === activeKey || !text.trim()) continue;
      const raw = key.slice(2);
      rows.push({ key, cwd: raw === "~" ? "" : raw, text, active: false });
    }
    return rows;
  }
  /** Persist the current composer text under its key so a switch / reload restores it.
   *  Empty (whitespace-only) drafts are removed rather than stored. Called on every
   *  switch, on a debounced keystroke, and on pagehide (see Composer). */
  stashDraft(): void {
    const key = this.composerDraftKey;
    if (this.composerDraft.trim()) this.draftMap[key] = this.composerDraft;
    else delete this.draftMap[key];
    persistDraftMap(this.draftMap);
  }
  /** Load the saved draft for `key` into the live composer (empty if none). */
  private loadDraft(key: string): void {
    this.composerDraft = this.draftMap[key] ?? "";
  }
  /** Drop a stored draft once it's been consumed (sent). */
  private clearStoredDraft(key: string): void {
    if (key in this.draftMap) {
      delete this.draftMap[key];
      persistDraftMap(this.draftMap);
    }
  }
  /** Persist the active new-session draft's config (worktree toggle + explicit model/thinking
   *  override) under its `n:<cwd>` key, so a session switch / reload restores it (startDraft
   *  rebuilds the draft from defaults and would otherwise drop it). Stores only what diverges
   *  from the default: worktree:true, and a model/thinking that isn't the current global
   *  default — so an untouched draft keeps tracking the default rather than pinning a stale one. */
  private persistDraftConfig(): void {
    if (!this.draft) return;
    const key = this.composerDraftKey;
    const def = this.modelDefaults;
    const cfg: StoredDraftConfig = {};
    if (this.draft.worktree) cfg.worktree = true;
    const m = this.draft.model;
    if (m && (m.provider !== def.provider || m.modelId !== def.modelId))
      cfg.model = m;
    if (this.draft.thinking && this.draft.thinking !== def.thinkingLevel)
      cfg.thinking = this.draft.thinking;
    if (cfg.worktree || cfg.model || cfg.thinking)
      this.draftConfigMap[key] = cfg;
    else delete this.draftConfigMap[key];
    persistDraftConfigMap(this.draftConfigMap);
  }
  /** Drop a stored draft's config once it's been consumed (sent) or discarded. */
  private clearStoredDraftConfig(key: string): void {
    if (key in this.draftConfigMap) {
      delete this.draftConfigMap[key];
      persistDraftConfigMap(this.draftConfigMap);
    }
  }

  /** The navigable prompt history for the current composer (oldest→newest), for ArrowUp/
   *  ArrowDown recall. Merges the focused session's transcript user messages (so an old
   *  session recalls immediately) with this client's local submit log (so a just-sent — or
   *  eaten — prompt is recallable even before/without the transcript). Consecutive duplicates
   *  collapse, which absorbs the window where a just-sent prompt sits in the log but hasn't
   *  yet folded into the transcript. While drafting a new session there's no transcript, so
   *  only the project's submit log applies. */
  get currentPromptHistory(): string[] {
    const logged = this.promptHistory[this.composerDraftKey] ?? [];
    const fromTranscript = this.draft
      ? []
      : this.session.items
          .filter((it) => it.kind === "user")
          .map((it) => it.text);
    const merged = [...fromTranscript, ...logged]
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return dedupeConsecutive(merged);
  }
  /** Append a sent prompt to the local submit log under `key`, capped + persisted. Skips a
   *  consecutive duplicate (resend / retry of the same text). Called from the submit
   *  chokepoints — prompt() and submitDraft(). */
  private recordPromptHistory(key: string, text: string): void {
    const t = text.trim();
    if (!t) return;
    const list = this.promptHistory[key] ?? [];
    if (list[list.length - 1] === t) return;
    const next = [...list, t].slice(-PROMPT_HISTORY_CAP);
    this.promptHistory = { ...this.promptHistory, [key]: next };
    persistPromptHistory(this.promptHistory);
  }

  get connection(): ConnectionState {
    return connectionState();
  }
  /** Authoritative transcript plus this client's optimistic outbox rows for the focused
   *  session. A server userMessage with the same prompt id suppresses the overlay before
   *  its ACK arrives, so event/ACK ordering never flashes a duplicate. */
  get transcriptItems(): TranscriptItem[] {
    const sessionId = this.session.ref?.sessionId;
    const existing = new Set(this.session.items.map((item) => item.id));
    const optimistic = this.pendingPrompts
      .filter(
        (prompt) =>
          prompt.kind === "prompt" &&
          prompt.sessionId === sessionId &&
          !existing.has(prompt.promptId),
      )
      .map((prompt): TranscriptItem => ({
        kind: "user",
        id: prompt.promptId,
        text: prompt.text,
        images: prompt.images,
        ts: prompt.createdAt,
        delivery: deliveryState(prompt.state, this.connection),
        deliveryError: prompt.error,
      }));
    const items = [...this.session.items, ...optimistic];
    // While a new session is being created, surface its first prompt at the top of the
    // (otherwise empty) transcript until the real userMessage lands — `existing.has`
    // then hands off to the authoritative row. Rendered from `creatingSession` rather
    // than the outbox so it survives the prompt's ACK, which deletes the pending entry a
    // beat before the server echoes the message back.
    const creating = this.creatingSession;
    if (creating && !existing.has(creating.promptId)) {
      const pending = this.pendingPrompts.find(
        (p) => p.promptId === creating.promptId,
      );
      items.push({
        kind: "user",
        id: creating.promptId,
        text: creating.text,
        images: creating.images,
        ts: creating.createdAt,
        // Mirror the in-flight delivery cue while the outbox entry is still live; once
        // ACKed it's a plain bubble (the "Starting session…" indicator carries the rest).
        delivery: pending
          ? deliveryState(pending.state, this.connection)
          : undefined,
      });
    }
    return items;
  }
  /** True when a turn is in flight for the FOCUSED session — the robust signal that
   *  drives the stop pill, the working indicator, and the composer's steer/queue mode.
   *
   *  The folded `session.status` alone is NOT enough: it only changes on snapshot-
   *  bearing events, while raw deltas/tool events never touch it. An out-of-band
   *  re-snapshot mid-turn (a rename / model change while a tool runs, when the agent's
   *  `isStreaming` momentarily reads false) flips it to "idle" even though the run
   *  continues — and on reconnect that corrupted status rides the snapshot. So we OR
   *  it with three independent in-flight signals a single glitch can't all clear at
   *  once: the server-authoritative running set (tracked separately by the hub from
   *  raw turn/tool events), an open streaming assistant bubble, and any still-running
   *  tool. A failed run is terminal — never active — even if a tool card is orphaned. */
  get turnActive(): boolean {
    // When drafting a new session, the main pane shows the new-session form —
    // not any running session. Hide streaming controls so the stop button and
    // steer/follow-up UI don't leak across from the previously-viewed session.
    if (this.draft) return false;
    const status = this.session.status;
    if (status === "running") return true;
    if (status === "failed") return false;
    const focusId = this.session.ref?.sessionId;
    if (focusId && this.runningIds.has(focusId)) return true;
    const items = this.session.items;
    const last = items[items.length - 1];
    if (last && last.kind === "assistant" && last.streaming) return true;
    return items.some((i) => i.kind === "tool" && i.status === "running");
  }

  /** Estimated tokens the model has streamed into the focused session's CURRENT turn —
   *  a liveness counter shown beside the working spinner so you can tell the API is
   *  actually feeding you (the number climbs) from a stall (it freezes). Sums assistant
   *  text + thinking since the last user/inject turn boundary; tools and earlier turns are
   *  excluded, so it resets per turn for free. It's an ESTIMATE (~4 chars/token): the agent only
   *  surfaces context-window usage to pilot, not exact per-turn output token counts, so we
   *  approximate from the streamed characters we already fold. Counting the thinking channel
   *  too is the point — it proves liveness during "Thinking…" when no answer text shows.
   *
   *  Turn boundary: we walk the tail and stop at a user/inject item (the start of this turn)
   *  OR a SETTLED assistant (one with `completedAt`, which only the turn-FINAL assistant gets
   *  — so a prior turn's reply never bleeds in). Intermediate bubbles a tool closed mid-turn
   *  carry no `completedAt`, so a multi-bubble turn still sums whole; tools/notices are skipped
   *  without breaking. */
  get turnStreamTokens(): number {
    const items = this.session.items;
    let chars = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it) continue;
      if (it.kind === "user" || it.kind === "inject") break;
      if (it.kind === "assistant") {
        if (it.completedAt) break;
        chars += it.text.length + it.thinking.length;
      }
    }
    return Math.round(chars / 4);
  }

  /** The just-sent prompt to restore to the composer when the user aborts a turn that
   *  hasn't produced output yet (Escape-to-abort UX). Returns the last user message's
   *  text iff nothing after it has emitted output — no assistant answer text and no
   *  tool call (thinking-only still counts as "no response yet"). Otherwise null: a
   *  turn that's already underway shouldn't yank the prompt back. History is left
   *  untouched either way — the orphaned user message stays as a visible "aborted"
   *  marker (duplicate prompts on resend are accepted, per the owner's call). */
  get abortRestoreText(): string | null {
    const items = this.session.items;
    let lastUserText: string | null = null;
    let lastUserIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === "user") {
        lastUserText = it.text;
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserText === null) return null;
    for (let i = lastUserIdx + 1; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (it.kind === "tool") return null;
      if (it.kind === "assistant" && it.text.trim().length > 0) return null;
    }
    return lastUserText;
  }

  start(): void {
    onMessage((msg) => this.onServer(msg));
    connect();
    void this.refreshPushState();
    // The inline script in index.html already applied the theme pre-paint; re-apply
    // (cheap, idempotent) in case it was blocked, and track live OS changes.
    applyThemeMode(this.themeMode);
    watchSystemTheme();
    // Likewise re-assert the pre-painted transcript text-scale (idempotent).
    applyFontScale(this.fontScale);
  }

  async refreshPushState(): Promise<void> {
    this.pushState = await currentPushState();
  }

  /** Explicit user-gesture enable (the header bell). Reports the outcome via pushState. */
  async enablePush(): Promise<void> {
    this.pushState = "working";
    this.pushState = await ensurePushSubscription();
  }

  /** Tear down the "creating new session" placeholder once its first prompt has actually
   *  landed in the focused transcript. Tied to the real item (not the snapshot or the
   *  ACK) so the optimistic first-prompt row hands off to the authoritative one without a
   *  gap — the overlay keeps showing it right up until `existing.has(promptId)` is true. */
  private maybeFinishCreating(): void {
    const id = this.creatingSession?.promptId;
    if (id !== undefined && this.session.items.some((item) => item.id === id))
      this.creatingSession = null;
  }

  private onServer(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        this.serverId = msg.serverId;
        this.dataDir = msg.dataDir ?? "";
        persistLastServerId(msg.serverId);
        void this.hydrateOutbox(msg.serverId);
        // A hello after the first is a reconnect: the hub will re-snapshot us onto the
        // landing, so remember the session we're viewing (captured now, before the
        // bootstrap snapshot overwrites `session`) to re-assert once the list arrives.
        if (this.booted && !this.draft)
          this.reconnectFocusId = this.session.ref?.sessionId ?? null;
        this.booted = true;
        break;
      case "snapshot":
        this.session = msg.state;
        this.ready = true;
        // A snapshot for the session we're creating may already carry its first prompt
        // (or none yet — the userMessage event folds in next). Either way, hand off.
        this.maybeFinishCreating();
        if (this.bootRestoreInFlight && msg.state.ref)
          this.bootRestoreInFlight = false;
        // A snapshot lands after a successful switch — clear the retry capture
        // (no need to retry an openSession that landed) + any stale switch error.
        this.lastAttemptedSessionPath = null;
        this.lastError = null;
        this.maybeOpenBootDraft();
        // Dev-only: time how long this full transcript render takes. The signal for
        // "is it time to build JS windowing?" (see docs/DESIGN.md).
        this.logRenderTiming(msg.state.items.length);
        break;
      case "event": {
        const ev = msg.event;
        // A blocking dialog this client was showing but didn't answer just vanished —
        // first-responder-wins resolved it on another device. Surface a transient notice
        // so the sheet doesn't silently disappear. (qna is inline; handled there.)
        if (ev.type === "hostUiResolved") {
          const wasShowing = this.session.pendingApprovals.some(
            (r) => r.requestId === ev.requestId && r.kind !== "qna",
          );
          if (wasShowing && !this.locallyResolved.has(ev.requestId))
            this.toast("Resolved on another device");
          this.locallyResolved.delete(ev.requestId);
        }
        foldEvent(this.session, ev);
        // The creating session's first userMessage may have just folded in — retire the
        // optimistic placeholder so the real row takes over without a flicker.
        this.maybeFinishCreating();
        break;
      }
      case "sessionList":
        this.sessions = [...msg.sessions];
        this.activeSessionId = msg.activeSessionId;
        this.defaultNewSessionCwd = msg.defaultNewSessionCwd;
        // Focus is server-authoritative today, but the preference is local to this
        // browser and keyed by the stable server id. Archived sessions deliberately
        // stop being boot targets: archiving is the operator saying "put this away".
        if (this.serverId && msg.activeSessionId) {
          const active = msg.sessions.find(
            (s) => s.sessionId === msg.activeSessionId,
          );
          if (active?.archived) clearLastSession(this.serverId);
          else if (active)
            persistLastSession(this.serverId, msg.activeSessionId);
        }
        // The session you're now viewing can't be unread.
        if (msg.activeSessionId) this.markRead(msg.activeSessionId);
        this.maybeOpenBootDraft();
        // Re-assert the pre-reconnect session now that the list (and the server's actual
        // new focus via activeSessionId) is in hand, so openSession's switch check fires.
        this.maybeRestoreFocus();
        break;
      case "sessionStatus": {
        // A session leaving the running set = a turn just finished. If it's a
        // background session (not the one you're looking at), flag it unread.
        // Exclude the focused session two ways: `activeSessionId` (from the session
        // list) AND the snapshot's `ref` (which always lands before live events) —
        // so a focused turn that completes before the list arrives never self-marks.
        const next = new Set(msg.runningIds);
        const viewing = this.session.ref?.sessionId;
        const newlyUnread = [...this.runningIds].filter(
          (id) =>
            !next.has(id) && id !== this.activeSessionId && id !== viewing,
        );
        this.runningIds = next;
        this.initializingIds = new Set(msg.initializingIds ?? []);
        this.attention = new Map(
          (msg.attention ?? []).map((item) => [item.sessionId, item]),
        );
        this.attentionVersion++;
        if (newlyUnread.length > 0)
          this.unread = new Set([...this.unread, ...newlyUnread]);
        break;
      }
      case "modelList":
        this.models = [...msg.models];
        break;
      case "commandList":
        this.commands = [...msg.commands];
        break;
      case "fileIndex":
        this.fileIndex = { files: [...msg.files], truncated: msg.truncated };
        break;
      case "fileList":
        this.files = { query: msg.query, items: [...msg.files] };
        break;
      case "dirListing":
        this.dirListing = {
          path: msg.path,
          parent: msg.parent,
          entries: [...msg.entries],
          error: msg.error,
        };
        this.dirLoading = false;
        break;
      case "pathStat":
        this.pathStat = {
          path: msg.path,
          exists: msg.exists,
          isDir: msg.isDir,
        };
        break;
      case "editorPrefill":
        // A branch landed on a user prompt — its text comes back to re-edit. Per-client
        // (only the requester), so it's handled here, not in the shared foldEvent. The
        // transcript re-seed rides a separate `snapshot`; composerDraft is local state it
        // doesn't touch, so order between them doesn't matter.
        this.composerDraft = msg.text;
        this.focusComposer();
        break;
      case "queueRestored": {
        const restored = [...msg.steering, ...msg.followUp].join("\n\n");
        if (restored) {
          this.composerDraft = [restored, this.composerDraft]
            .filter((text) => text.trim())
            .join("\n\n");
          this.focusComposer();
        }
        break;
      }
      case "promptResult":
        void this.settlePrompt(msg);
        break;
      case "modelDefaults":
        this.modelDefaults = msg.defaults;
        break;
      case "pilotSettings":
        this.pilotSettings = msg.settings;
        this.loginEnv = msg.env;
        this.loginShellPendingRestart = msg.pendingRestart;
        this.backgroundModelWarning = msg.backgroundModelWarning;
        break;
      case "trustRequest":
        this.trustRequest = {
          requestId: msg.requestId,
          cwd: msg.cwd,
          title: msg.title,
          options: msg.options,
        };
        break;
      case "trustResolved":
        if (this.trustRequest?.requestId === msg.requestId)
          this.trustRequest = null;
        break;
      case "updateStatus":
        this.appUpdate = msg.available
          ? { sha: msg.sha ?? "", applying: msg.applying }
          : null;
        this.desktopStale = msg.desktopStale === true;
        break;
      case "error":
        if (msg.message === "unauthorized") {
          this.unauthorized = true;
          // Rejected after we'd connected → a token expired/was revoked mid-session,
          // not a cold first-run gate. Lets TokenGate say so.
          this.unauthorizedReason = "expired";
          disconnect(); // stop the reconnect loop until a new token is entered
        } else if (msg.kind === "session-switch") {
          // A known, common session-open failure (daemon didn't start, lease
          // conflict, port didn't bind). These aren't unexpected crashes — render
          // as a dismissible toast, not the alarming red error banner. The generic
          // banner (no kind) stays for genuinely unexpected errors.
          console.error("[server error]", msg.message);
          if (this.bootRestoreInFlight) {
            this.bootRestoreInFlight = false;
            if (this.serverId) clearLastSession(this.serverId);
            this.startDraft(this.defaultNewSessionCwd);
          }
          // A lease conflict (409) is retryable: the operator /detach in the TUI
          // or waits for the lease to lapse, then taps Retry to re-send openSession.
          // The message comes from classifySwitchError (hub.ts) — either the full
          // claimLease text ("another TUI is attached…") or the fallback ("…lease to
          // lapse."). Both match the pattern. Sticky (no auto-dismiss) so it doesn't
          // vanish while the operator is detaching in the TUI.
          if (
            LEASE_CONFLICT_RE.test(msg.message) &&
            this.lastAttemptedSessionPath
          ) {
            const retryPath = this.lastAttemptedSessionPath;
            this.toast(msg.message, {
              action: {
                label: "Retry",
                run: () => this.openSession(retryPath),
              },
              durationMs: 0,
            });
          } else {
            // Non-lease-conflict session-switch errors (daemon didn't start, port
            // didn't bind) aren't blindly retryable — keep the existing 8s toast.
            this.toast(msg.message, { durationMs: 8000 });
          }
        } else {
          console.error("[server error]", msg.message);
          this.lastError = msg.message;
          if (
            this.bootRestoreInFlight &&
            msg.message.startsWith("session switch failed")
          ) {
            this.bootRestoreInFlight = false;
            if (this.serverId) clearLastSession(this.serverId);
            this.startDraft(this.defaultNewSessionCwd);
          }
        }
        break;
      case "worktreeRetained": {
        // Archive reaped the session but kept its worktree (dirty). Explain the leftover
        // and offer a force-delete so it isn't a mystery directory on disk.
        const path = msg.path;
        this.toast(`Worktree kept — ${msg.reason}`, {
          action: {
            label: "Delete anyway",
            run: () => this.cleanupWorktree(path, true),
          },
          durationMs: 12000,
        });
        break;
      }
    }
  }

  /** Save a token and reconnect (from the auth gate). */
  authenticate(token: string): void {
    setToken(token);
    this.unauthorized = false;
    this.unauthorizedReason = null;
    connect();
  }
  reconnect(): void {
    forceReconnect();
  }

  private async hydrateOutbox(serverId: string): Promise<void> {
    if (this.hydratedOutboxServerId === serverId) {
      this.flushOutbox();
      return;
    }
    try {
      const stored = await loadPendingPrompts(serverId);
      const liveById = new Map(
        this.pendingPrompts
          .filter((prompt) => prompt.serverId === serverId)
          .map((prompt) => [prompt.promptId, prompt]),
      );
      for (const prompt of stored)
        if (!liveById.has(prompt.promptId))
          liveById.set(prompt.promptId, prompt);
      this.pendingPrompts = [...liveById.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      this.hydratedOutboxServerId = serverId;
      this.flushOutbox();
    } catch (e) {
      this.lastError = `couldn't restore pending prompts: ${errorText(e)}`;
    }
  }

  private flushOutbox(): void {
    if (this.connection !== "connected") return;
    for (const prompt of this.pendingPrompts)
      if (prompt.state !== "rejected") this.sendPendingPrompt(prompt.promptId);
  }

  private sendPendingPrompt(promptId: string): void {
    const prompt = this.pendingPrompts.find(
      (item) => item.promptId === promptId,
    );
    if (!prompt || prompt.state === "rejected") return;
    const sent =
      prompt.kind === "prompt"
        ? send({
            type: "prompt",
            promptId: prompt.promptId,
            text: prompt.text,
            images: prompt.images,
            deliverAs: prompt.deliverAs,
            sessionId: prompt.sessionId,
          })
        : send({
            type: "newSession",
            promptId: prompt.promptId,
            cwd: prompt.newSession?.cwd,
            worktree: prompt.newSession?.worktree,
            model: prompt.newSession?.model,
            thinking: prompt.newSession?.thinking,
            prompt: prompt.text,
            images: prompt.images,
          });
    const state = sent ? "sending" : "queued";
    if (prompt.state !== state) {
      this.pendingPrompts = this.pendingPrompts.map((item) =>
        item.promptId === promptId ? { ...item, state } : item,
      );
      void savePendingPrompt({ ...prompt, state }).catch((e) => {
        this.lastError = `couldn't update the prompt outbox: ${errorText(e)}`;
      });
    }
  }

  /** Enqueue + send a prompt. Returns the new outbox promptId on success (truthy), or
   *  null on failure (still connecting / local-storage write failed). */
  private async enqueuePrompt(
    prompt: Omit<
      PendingPrompt,
      "promptId" | "serverId" | "createdAt" | "state"
    >,
  ): Promise<string | null> {
    const serverId = this.serverId ?? loadLastServerId();
    if (!serverId) {
      this.lastError =
        "Still connecting — your prompt is still in the composer.";
      return null;
    }
    // `$state` values reach here as reactive proxies (composer images, draft
    // model/options), which IndexedDB refuses to clone. `savePendingPrompt` is the
    // single boundary that rebuilds plain data, so we can pass nested fields straight
    // through here and at every other save site.
    const pending: PendingPrompt = {
      kind: prompt.kind,
      text: prompt.text,
      images: prompt.images,
      deliverAs: prompt.deliverAs,
      sessionId: prompt.sessionId,
      newSession: prompt.newSession,
      promptId: createPromptId(),
      serverId,
      createdAt: new Date().toISOString(),
      state: "queued",
    };
    try {
      // Durability comes before clearing the composer or touching the socket.
      await savePendingPrompt(pending);
    } catch (e) {
      this.lastError = `couldn't save the prompt locally: ${errorText(e)}`;
      return null;
    }
    this.pendingPrompts = [...this.pendingPrompts, pending];
    // The optimistic bubble just landed at the tail — ask the transcript to follow it
    // to the bottom (re-pinning if the reader had scrolled up).
    this.promptSentN++;
    this.sendPendingPrompt(pending.promptId);
    return pending.promptId;
  }

  private async settlePrompt(
    result: Extract<ServerMessage, { type: "promptResult" }>,
  ): Promise<void> {
    const prompt = this.pendingPrompts.find(
      (item) => item.promptId === result.promptId,
    );
    if (!prompt) return;
    if (result.accepted) {
      try {
        await deletePendingPrompt(result.promptId);
        this.pendingPrompts = this.pendingPrompts.filter(
          (item) => item.promptId !== result.promptId,
        );
      } catch (e) {
        this.lastError = `prompt was accepted, but its local outbox entry couldn't be cleared: ${errorText(e)}`;
      }
      return;
    }
    // Any rejection retires the "creating session" placeholder (a SUCCESS clears it via the
    // real userMessage landing in the transcript — see maybeFinishCreating — so the
    // optimistic row never blinks out before its authoritative replacement arrives).
    if (result.promptId === this.creatingSession?.promptId)
      this.creatingSession = null;
    // A new-session creation that failed before any session existed (no sessionId): its
    // draft was already cleared on submit, and a kind:"newSession" rejection has no
    // transcript surface (the optimistic overlay only renders kind:"prompt" rows for the
    // focused session). So recover the prompt into a draft rather than strand it invisibly
    // in the outbox. (A newSession that DID create a session but failed its first prompt
    // carries a sessionId — that falls through to the normal rejected-row path below, which
    // renders in the now-focused session with Retry/Edit.)
    if (!result.sessionId && prompt.kind === "newSession") {
      const competingDraft =
        this.draft !== null &&
        (this.composerDraft.trim().length > 0 ||
          this.composerImages.length > 0);
      if (!competingDraft) {
        // Pane is free (no draft, or one you haven't typed into) — restore straight away.
        await this.restoreFailedDraft(prompt);
        return;
      }
      // You're mid-typing a different draft — don't clobber it. Keep the entry in the
      // outbox as rejected (so flushOutbox won't resend it, and a reload during the offer
      // window doesn't lose it) and offer a one-tap restore.
      const stranded: PendingPrompt = {
        ...prompt,
        state: "rejected",
        error: result.error ?? "The new session couldn't be created",
      };
      this.pendingPrompts = this.pendingPrompts.map((item) =>
        item.promptId === result.promptId ? stranded : item,
      );
      try {
        await savePendingPrompt(stranded);
      } catch (e) {
        this.lastError = `couldn't persist the failed prompt: ${errorText(e)}`;
      }
      this.toast("New session couldn't start — restore your prompt?", {
        action: {
          label: "Restore",
          run: () => void this.restoreFailedDraft(stranded),
        },
        durationMs: 0,
      });
      return;
    }
    const rejected: PendingPrompt = {
      ...prompt,
      kind: result.sessionId ? "prompt" : prompt.kind,
      sessionId: result.sessionId ?? prompt.sessionId,
      state: "rejected",
      error: result.error ?? "The server rejected this prompt",
    };
    this.pendingPrompts = this.pendingPrompts.map((item) =>
      item.promptId === result.promptId ? rejected : item,
    );
    try {
      await savePendingPrompt(rejected);
    } catch (e) {
      this.lastError = `couldn't persist the rejected prompt: ${errorText(e)}`;
    }
  }

  /** Bring a failed new-session draft back into view: its config (cwd/worktree/model/
   *  thinking) → chips, its prompt text/images → the composer, and drop the now-consumed
   *  outbox entry. Mirrors startDraft's stash-then-flip, but seeds from the failed prompt
   *  instead of model defaults, and persists the text immediately (a second stash) so a
   *  reload right after recovery keeps it. Reused by both the auto-restore path and the
   *  toast's Restore action. */
  private async restoreFailedDraft(prompt: PendingPrompt): Promise<void> {
    // Save whatever session/draft we're leaving before flipping into the recovered draft.
    this.stashDraft();
    this.searchOpen = false;
    // The creation failed — retire its placeholder before re-showing the draft form.
    this.creatingSession = null;
    const ns = prompt.newSession;
    this.draft = {
      cwd: ns?.cwd ?? "",
      worktree: ns?.worktree ?? false,
      model: ns?.model,
      thinking: ns?.thinking,
    };
    this.composerDraft = prompt.text;
    this.composerImages = prompt.images ? [...prompt.images] : [];
    // Persist the restored text under n:<cwd> now (stashDraft keys off the live draft),
    // so a reload before the next keystroke-stash doesn't drop it.
    this.stashDraft();
    this.persistDraftConfig();
    this.pushNav({ kind: "draft", cwd: this.draft.cwd });
    if (this.draft.cwd) this.setLastProjectCwd(this.draft.cwd);
    this.focusComposer();
    try {
      await deletePendingPrompt(prompt.promptId);
      this.pendingPrompts = this.pendingPrompts.filter(
        (item) => item.promptId !== prompt.promptId,
      );
    } catch (e) {
      this.lastError = `restored your prompt, but couldn't clear its outbox copy: ${errorText(e)}`;
    }
  }

  async prompt(
    text: string,
    deliverAs?: "steer" | "followUp",
    images?: ImageContent[],
  ): Promise<boolean> {
    const t = text.trim();
    if (!t && (!images || images.length === 0)) return false;
    // This call is a user gesture — the moment to ask for notification permission
    // (tab-open path) and register a Web Push subscription (closed-phone path).
    ensurePermission();
    void ensurePushSubscription().then((s) => {
      this.pushState = s;
    });
    const accepted = await this.enqueuePrompt({
      kind: "prompt",
      text: t,
      images,
      deliverAs,
      sessionId: this.session.ref?.sessionId ?? undefined,
    });
    if (!accepted) return false;
    // Record the sent prompt for ArrowUp recall, then clear the live text AND its stored copy.
    this.recordPromptHistory(this.composerDraftKey, t);
    this.clearStoredDraft(this.composerDraftKey);
    this.composerDraft = "";
    this.composerImages = [];
    return true;
  }
  abort(): void {
    // A bare send is dropped while the socket's down. Mirror restoreQueue and surface it,
    // so an Esc-abort offline gives feedback instead of silently no-opping (the Stop pill
    // itself is disabled while disconnected).
    if (!send({ type: "abort" }))
      this.lastError = "Can't stop the agent while offline — it keeps running.";
  }
  /** Pi-parity dequeue: atomically clear every steer/follow-up and return it here. */
  restoreQueue(): void {
    if (!send({ type: "restoreQueue" }))
      this.lastError = "Can't restore queued messages while offline.";
  }
  /** Apply the staged desktop update now (the sidebar card's button). The server marks
   *  it applying; the watcher pulls/rebuilds/restarts and the card clears on reconnect.
   *  We also ping the native desktop shell (no-op in a browser/PWA) so it raises its
   *  fullscreen "Updating…" overlay immediately, rather than trailing the click by ~one
   *  watcher poll (≈5s) until the watcher's first `apply` event reaches it. Gated on the
   *  send landing: if the socket is down the request never reaches the hub, so don't raise
   *  an overlay that nothing would ever tear down (until the native 5-min failsafe). */
  requestAppUpdate(): void {
    if (send({ type: "applyUpdate" })) notifyNativeUpdateStarting();
  }
  /** Force an update now (the build-stamp right-click menu) — for clicking right after a
   *  push to main, before the watcher's next fetch has noticed the commit. Unlike
   *  requestAppUpdate this isn't a no-op when nothing is staged: the watcher fetches and
   *  applies on its next poll if origin/main moved. Feedback is the restart/reconnect (and
   *  a new build hash); a no-op force (already current) shows nothing. */
  requestForceUpdate(): void {
    send({ type: "forceUpdate" });
  }
  /** Resume after a run-failed: send a minimal "continue" signal. The prior prompt
   *  was already accepted by the daemon (runFailed only fires after the turn
   *  started — message_start → message_complete with a turn error), so re-sending
   *  it verbatim is wasteful. "continue" nudges the agent to proceed without
   *  replaying the full prior message (which is already in the daemon's history). */
  resumeTurn(): void {
    void this.prompt("continue");
  }
  async retryPending(promptId: string): Promise<void> {
    const old = this.pendingPrompts.find((item) => item.promptId === promptId);
    if (!old || old.state !== "rejected") return;
    try {
      await deletePendingPrompt(promptId);
    } catch (e) {
      this.lastError = `couldn't update the prompt outbox: ${errorText(e)}`;
      return;
    }
    this.pendingPrompts = this.pendingPrompts.filter(
      (item) => item.promptId !== promptId,
    );
    const queued = await this.enqueuePrompt({
      kind: old.kind,
      text: old.text,
      images: old.images,
      deliverAs: old.deliverAs,
      sessionId: old.sessionId,
      newSession: old.newSession,
    });
    if (!queued) {
      try {
        await savePendingPrompt(old);
        this.pendingPrompts = [...this.pendingPrompts, old];
      } catch {
        // enqueuePrompt already surfaced the storage failure; keep the copy in the
        // composer as the final no-loss fallback.
        this.composerDraft = old.text;
        this.composerImages = old.images ? [...old.images] : [];
      }
    }
  }
  async editPending(promptId: string): Promise<void> {
    const old = this.pendingPrompts.find((item) => item.promptId === promptId);
    if (!old || old.state !== "rejected") return;
    try {
      await deletePendingPrompt(promptId);
    } catch (e) {
      this.lastError = `couldn't update the prompt outbox: ${errorText(e)}`;
      return;
    }
    this.pendingPrompts = this.pendingPrompts.filter(
      (item) => item.promptId !== promptId,
    );
    this.composerDraft = old.text;
    this.composerImages = old.images ? [...old.images] : [];
    this.focusComposer();
  }
  respondUi(response: HostUiResponse): void {
    // Remember we answered this one, so the echoed hostUiResolved isn't read as a
    // "resolved on another device" event (see the "event" case).
    this.locallyResolved.add(response.requestId);
    send({ type: "respondUi", response });
  }
  /** Answer the project-trust card. `choice` indexes the options; null denies. Clears
   *  optimistically; the server's `trustResolved` confirms (and dismisses other tabs). */
  respondTrust(choice: number | null): void {
    const req = this.trustRequest;
    if (!req) return;
    send({ type: "trustResponse", requestId: req.requestId, choice });
    this.trustRequest = null;
  }
  mock(script: string): void {
    send({ type: "mock", script });
  }
  /** Ask the server to search for files matching a composer @-mention query.
   *  The result arrives as a `fileList` server message (the `query` field is
   *  echoed back so we can ignore stale responses). Called debounced (~150ms)
   *  from the Composer on each keystroke after `@`. `cwd` targets a new-session
   *  draft's project dir (no session exists yet); omitted -> the focused session's cwd. */
  queryFiles(query: string, cwd?: string): void {
    send({ type: "queryFiles", query, cwd });
  }
  /** Browse a directory on the SERVER's filesystem for the new-session project picker.
   *  Empty/omitted -> the server's $HOME. The reply arrives as a `dirListing` message
   *  (it echoes the resolved `path` so the picker can drop a stale response). */
  queryDir(path?: string): void {
    this.dirLoading = true;
    send({ type: "queryDir", path });
  }
  /** Quick existence + type check for a path typed into the new-session dir picker.
   *  The server responds with {@link pathStat} — the picker reads it for inline
   *  validation. Debounced by the caller (the picker), not here. */
  statPath(path: string): void {
    send({ type: "statPath", path });
  }
  /** Rewind the session to a prior tree entry (the daemon's /rewind — destructive:
   *  drops the target entry and everything after). The server re-seeds every
   *  client's transcript to the rewound point; if `entryId` was a user prompt,
   *  this client also gets an `editorPrefill` with its text. No-op while a turn
   *  is running (the server rejects it — a mid-turn navigate would corrupt). */
  branch(entryId: string): void {
    if (this.turnActive) return;
    send({ type: "branch", entryId });
  }
  /** Rewind from the most recent user prompt — the "edit & resend my last message"
   *  gesture, bound to a global hotkey. Finds the last user item carrying a branch
   *  handle and rewinds to it. */
  branchLastPrompt(): void {
    const items = this.session.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && it.kind === "user" && it.entryId) {
        this.branch(it.entryId);
        return;
      }
    }
  }
  openSession(path: string): void {
    const switching = path !== this.activeSessionPath;
    // Save the draft we're leaving (the new-session draft, or the prior session's text)
    // before the composer re-points; navigating to a session exits any new-session draft.
    this.stashDraft();
    this.draft = null;
    // Navigating away abandons any in-flight "creating session" placeholder — its
    // optimistic prompt row must not bleed onto the session we're switching to.
    this.creatingSession = null;
    const entry = this.sessions.find((s) => s.path === path);
    const id = entry?.sessionId;
    // Restore the target's saved draft into the composer (empty if none).
    this.loadDraft(id ? `s:${id}` : "none");
    // Record this view for ⌘[ / ⌘] history and remember its project for ⌘N. Done before
    // the no-switch early-return so exiting a draft onto the active session still records
    // the move from draft → session.
    if (id) {
      this.pushNav({ kind: "session", sessionId: id });
      if (entry?.cwd) this.setLastProjectCwd(entry.cwd);
    }
    // Same session (e.g. tapped the active row while drafting) — we've exited the draft
    // and restored its text; nothing to switch.
    if (!switching) return;
    // Optimistic: opening a session reads it (the authoritative clear also rides the
    // next `sessionList`, but this avoids a flicker of the unread dot mid-switch).
    if (id) this.markRead(id);
    // A switched-to session renders at the bottom — clear any stale below-fold flag.
    this.clearActiveUnread();
    // Drop the @-mention file caches: both are cwd-scoped, so the new session would
    // otherwise show the prior cwd's files until the server pushes a fresh `fileIndex`
    // (on switch). The stale index is the one that bites — it'd match instantly when the
    // user types `@`. The fallback-query cache is cleared for the same reason.
    this.fileIndex = { files: [], truncated: false };
    this.files = { query: "", items: [] };
    this.lastAttemptedSessionPath = path;
    send({ type: "openSession", path });
  }
  /** Focus a session named by cross-session attention/notification metadata. */
  openSessionById(sessionId: string): void {
    const session = this.sessions.find((item) => item.sessionId === sessionId);
    if (session) this.openSession(session.path);
  }
  /** Dev-only timing for a full transcript render (fires on every snapshot: session
   *  open, switch, reconnect, mid-turn re-snapshot). Gated behind `?dev` — the same
   *  runtime URL flag that reveals the dev bar — so production stays silent until you
   *  add `?dev` to the URL in any deploy. Watch the trend: when `itemCount` climbs into
   *  the thousands AND the paint time grows past a perceptible pause, JS windowing
   *  (render only the last N turns + "load older") starts to earn its complexity. The
   *  transcript renders every item up front (no JS virtualization, no CSS
   *  content-visibility): rows render at their true height immediately. (content-visibility
   *  was tried as a zero-JS virtualization but reverted — its estimated contain-intrinsic-size
   *  made off-screen rows snap to real height as you scrolled up, drifting the viewport
   *  into tall messages. `e2e/transcript.e2e.ts` guards the no-CV invariant.) Real JS windowing
   *  that preserves scroll on prepend is the proper fix when item counts climb into the
   *  thousands. */
  private logRenderTiming(itemCount: number): void {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("dev")) return;
    const start = performance.now();
    // Two frames: the first lets Svelte flush + the browser lay out/paint the new
    // transcript; the second fires once that painted frame is done, so the delta
    // covers script + layout + paint, not just the scripting before the frame.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const ms = Math.round(performance.now() - start);
        console.debug(
          `[pilot] transcript render: ${itemCount} items · ${ms}ms (to paint)`,
        );
      }),
    );
  }
  private markRead(sessionId: string): void {
    if (!this.unread.has(sessionId)) return;
    const next = new Set(this.unread);
    next.delete(sessionId);
    this.unread = next;
  }
  /** Transcript reports new content arrived below the viewport (grew while scrolled up).
   *  Flags the active session unread until the user scrolls back to the bottom. */
  markActiveUnread(): void {
    if (!this.activeUnread) this.activeUnread = true;
  }
  /** The transcript reached the bottom (or a fresh session loaded at the bottom): the
   *  active session has no unread content below the fold anymore. */
  clearActiveUnread(): void {
    if (this.activeUnread) this.activeUnread = false;
  }
  /** The sidebar indicator for a session: a live turn, warming up, new-since-viewed, or
   *  idle. Running wins over initializing (mutually exclusive server-side; defensive
   *  here); both outrank unread/read. */
  sessionStatus(
    sessionId: string,
  ):
    | "waiting"
    | "failed"
    | "running"
    | "initializing"
    | "done"
    | "unread"
    | "read" {
    const attention = this.attention.get(sessionId);
    if (attention?.phase === "waiting") return "waiting";
    if (attention?.phase === "failed") return "failed";
    if (this.runningIds.has(sessionId)) return "running";
    if (this.initializingIds.has(sessionId)) return "initializing";
    if (attention?.phase === "done" && this.unread.has(sessionId))
      return "done";
    if (this.unread.has(sessionId)) return "unread";
    // The active session is normally "read", but flags unread when new content landed
    // below the viewport while you were scrolled up (cleared on scroll-to-bottom).
    if (sessionId === this.activeSessionId && this.activeUnread)
      return "unread";
    return "read";
  }
  /** Human-readable second line for a row that currently deserves attention. */
  sessionActivity(sessionId: string): string | null {
    const attention = this.attention.get(sessionId);
    if (!attention) return null;
    if (attention.phase === "waiting") {
      const count = attention.pendingCount ?? 1;
      const title = attention.pendingTitle ?? "Waiting on you";
      return count > 1 ? `${title} · ${count} requests` : title;
    }
    if (attention.phase === "failed")
      return attention.activity
        ? `Failed · ${attention.activity}`
        : "Run failed";
    if (attention.phase === "running") return attention.activity ?? "Working";
    if (attention.phase === "done" && this.unread.has(sessionId)) return "Done";
    return null;
  }
  /** Highest-priority state in a collapsed project group. */
  groupAttention(
    sessionIds: readonly string[],
  ): "waiting" | "failed" | "running" | "done" | null {
    const states = sessionIds.map((id) => this.sessionStatus(id));
    if (states.includes("waiting")) return "waiting";
    if (states.includes("failed")) return "failed";
    if (states.includes("running") || states.includes("initializing"))
      return "running";
    if (states.includes("done") || states.includes("unread")) return "done";
    return null;
  }
  /** On boot, if no session is active (empty landing), restore this client's last
   *  focused session for the current Pilot server. If none survives, open a new-session
   *  draft at $HOME so the operator lands on a prompt page rather than a blank transcript.
   *  Fires at most once per store instance (reconnects don't re-open a dismissed
   *  draft), and only when both the snapshot and the sessionList have arrived —
   *  hello carries serverId, snapshot carries ref/ready, and sessionList carries the
   *  available sessions + activeSessionId + $HOME. */
  private maybeOpenBootDraft(): void {
    if (this.bootDraftHandled) return;
    if (!this.serverId || !this.ready || !this.defaultNewSessionCwd) return;
    const requestedId = requestedSessionId();
    if (requestedId) {
      const requested = this.sessions.find(
        (session) => session.sessionId === requestedId,
      );
      clearRequestedSession();
      if (requested) {
        this.bootDraftHandled = true;
        if (
          requested.sessionId !== this.activeSessionId ||
          requested.sessionId !== this.session.ref?.sessionId
        ) {
          this.bootRestoreInFlight = true;
          this.openSession(requested.path);
        } else {
          this.loadDraft(`s:${requested.sessionId}`);
          this.pushNav({ kind: "session", sessionId: requested.sessionId });
        }
        return;
      }
    }
    this.bootDraftHandled = true;
    if (
      this.activeSessionId === null &&
      this.session.ref === null &&
      this.draft === null
    ) {
      const savedId = loadLastSession(this.serverId);
      const saved = savedId
        ? this.sessions.find((s) => s.sessionId === savedId && !s.archived)
        : undefined;
      if (saved) {
        this.bootRestoreInFlight = true;
        this.openSession(saved.path);
        return;
      }
      if (savedId) clearLastSession(this.serverId);
      this.startDraft(this.defaultNewSessionCwd);
    } else if (!this.draft && this.activeSessionId) {
      // Booted/reconnected straight onto a session — restore its saved draft so a reload
      // doesn't lose a half-typed prompt, and seed it as the initial back/forward entry
      // (this path skips openSession, so nothing else records it).
      this.loadDraft(`s:${this.activeSessionId}`);
      this.pushNav({ kind: "session", sessionId: this.activeSessionId });
    }
  }

  /** After a reconnect, jump back to the session we were reading. A fresh socket re-
   *  registers server-side focused on the empty landing (hub.addClient), so a phone whose
   *  link blips would otherwise land on a blank pane mid-session. `hello` stashed the viewed
   *  session id; re-open it unless we've since started a draft, or the server happened to
   *  keep us there (e.g. the landing IS that session, as in the mock). Idempotent: openSession
   *  triggers another snapshot/list, but reconnectFocusId is already cleared so it no-ops. */
  private maybeRestoreFocus(): void {
    const want = this.reconnectFocusId;
    this.reconnectFocusId = null;
    if (!want || this.draft) return;
    if (this.session.ref?.sessionId === want) return;
    const target = this.sessions.find((s) => s.sessionId === want);
    if (target) this.openSession(target.path);
  }

  /** Open the new-session draft. `cwd` prefills the project (the sidebar passes the
   *  group's cwd, or the active session's). Model/thinking seed from the agent's global
   *  defaults so the chips reflect what a plain new session would use. */
  startDraft(cwd = ""): void {
    // Save whatever session/draft we're leaving before flipping into the new draft.
    this.stashDraft();
    // A fresh draft replaces any in-flight "creating session" placeholder.
    this.creatingSession = null;
    // Find-in-transcript is a transcript-reading tool; entering a draft is a context
    // switch, so don't let an open find box linger across it.
    this.searchOpen = false;
    const d = this.modelDefaults;
    this.draft = {
      cwd,
      worktree: false,
      model:
        d.provider && d.modelId
          ? { provider: d.provider, modelId: d.modelId }
          : undefined,
      thinking: d.thinkingLevel,
    };
    // Restore this project's pending new-session draft, if any (key now resolves to n:cwd).
    this.loadDraft(this.composerDraftKey);
    // Restore this project's persisted draft config (text rides draftMap; worktree + any
    // model/thinking override ride draftConfigMap, both keyed by n:<cwd>). Each field falls
    // back to the default seed when absent.
    const saved = this.draftConfigMap[this.composerDraftKey];
    if (saved)
      this.draft = {
        ...this.draft,
        worktree: saved.worktree ?? this.draft.worktree,
        model: saved.model ?? this.draft.model,
        thinking: saved.thinking ?? this.draft.thinking,
      };
    // Record the draft view for ⌘[ / ⌘] history and remember its project for ⌘N.
    this.pushNav({ kind: "draft", cwd });
    if (cwd) this.setLastProjectCwd(cwd);
  }
  cancelDraft(): void {
    // Keep the new-session draft for next time, then drop back to the active session's draft.
    this.stashDraft();
    this.draft = null;
    this.creatingSession = null;
    this.loadDraft(this.composerDraftKey);
  }
  /** Discard a pending new-session draft (the sidebar ×). Drops its stashed text
   *  outright (no stash). If it's the draft being actively composed, also exits the
   *  draft, falling back to the active session's own draft (or the empty landing). */
  discardDraft(key: string): void {
    if (key in this.draftMap) {
      delete this.draftMap[key];
      persistDraftMap(this.draftMap);
    }
    this.clearStoredDraftConfig(key);
    if (this.draft && this.composerDraftKey === key) {
      this.draft = null;
      this.composerDraft = "";
      this.loadDraft(this.composerDraftKey);
    }
  }
  setDraftCwd(cwd: string): void {
    if (!this.draft) return;
    const oldKey = this.composerDraftKey; // n:<old cwd>
    this.draft = { ...this.draft, cwd };
    const newKey = this.composerDraftKey; // n:<new cwd>
    // Retarget moves the draft's row to the new project — drop the old key's stashed
    // copy so the same draft doesn't ghost under the project we just left. The live
    // text rides `composerDraft` and re-stashes under newKey on the next switch.
    if (oldKey !== newKey) {
      if (oldKey in this.draftMap) {
        delete this.draftMap[oldKey];
        persistDraftMap(this.draftMap);
      }
      // The worktree pref follows the draft to its new project key.
      if (oldKey in this.draftConfigMap) delete this.draftConfigMap[oldKey];
      this.persistDraftConfig(); // re-writes the live config under newKey (+ persists)
    }
  }
  toggleDraftWorktree(): void {
    if (this.draft) {
      this.draft = { ...this.draft, worktree: !this.draft.worktree };
      this.persistDraftConfig();
    }
  }
  /** Commit the draft: create the session and deliver its first prompt in one
   *  message. Mirrors prompt()'s permission/push gesture since this IS the first turn. */
  async submitDraft(text: string, images?: ImageContent[]): Promise<boolean> {
    const d = this.draft;
    if (!d) return false;
    const t = text.trim();
    if (!t && (!images || images.length === 0)) return false;
    ensurePermission();
    void ensurePushSubscription().then((s) => {
      this.pushState = s;
    });
    const promptId = await this.enqueuePrompt({
      kind: "newSession",
      text: t,
      images,
      newSession: {
        cwd: d.cwd.trim() || undefined,
        worktree: d.worktree || undefined,
        model: d.model,
        thinking: d.thinking,
      },
    });
    if (!promptId) return false;
    // Record the sent prompt for ArrowUp recall (key is n:cwd while the draft is still set),
    // then drop the pending new-session draft's stored copy.
    this.recordPromptHistory(this.composerDraftKey, t);
    this.clearStoredDraft(this.composerDraftKey);
    this.clearStoredDraftConfig(this.composerDraftKey);
    this.draft = null;
    this.composerDraft = "";
    this.composerImages = [];
    // Hand the transcript a clean slate immediately. Without this it keeps rendering the
    // PREVIOUSLY focused session (still held in `this.session`) for the whole session warm-up
    // window, flashing that old transcript before the new session's snapshot lands. We
    // reset to an empty state and mark the creation pending so the only thing shown is the
    // optimistic first-prompt row (transcriptItems) + the "Starting session…" indicator,
    // both of which carry seamlessly into the real session once its snapshot arrives.
    this.session = initialSessionState();
    this.creatingSession = {
      promptId,
      text: t,
      images: images ? [...images] : undefined,
      createdAt: new Date().toISOString(),
    };
    return true;
  }
  /** PWA: a newer service worker installed — raise the refresh prompt (set from sw.ts). */
  markUpdateReady(): void {
    this.swUpdateReady = true;
  }
  /** Reload to pick up the new service worker's assets. */
  applyUpdate(): void {
    window.location.reload();
  }
  dismissUpdate(): void {
    this.swUpdateReady = false;
  }
  openSettings(): void {
    this.settingsOpen = true;
  }
  closeSettings(): void {
    this.settingsOpen = false;
  }
  /** ⌘F — open the in-transcript find box and (re)focus it. No-op while drafting: there's
   *  no transcript to search, so we leave native ⌘F to the draft form instead. */
  openSearch(): void {
    if (this.draft) return;
    this.searchOpen = true;
    this.searchFocusN++;
  }
  closeSearch(): void {
    this.searchOpen = false;
  }
  togglePlanView(): void {
    this.planViewOpen = !this.planViewOpen;
  }
  /** Change the theme override (system/light/dark); persisted + applied immediately. */
  setTheme(mode: ThemeMode): void {
    this.themeMode = mode;
    setThemeMode(mode);
  }
  /** Toggle whether thinking blocks are hidden (replaced with a subtle placeholder). */
  setHideThinking(hide: boolean): void {
    this.hideThinking = hide;
    persistHideThinking(hide);
  }
  /** Set the transcript reading-size multiplier (clamped + persisted + applied). */
  setFontScale(scale: number): void {
    this.fontScale = persistFontScale(scale);
  }
  /** Nudge the transcript text-size by one step (⌘= / ⌘-). */
  bumpFontScale(delta: number): void {
    this.setFontScale(this.fontScale + delta);
  }
  /** Reset the transcript text-size to the default (⌘0). */
  resetFontScale(): void {
    this.setFontScale(1);
  }
  /** True if an access token is saved on this device (we never reveal its value). */
  get hasToken(): boolean {
    return !!getToken();
  }
  /** Save a new token and reconnect with it (from the settings panel). */
  changeToken(token: string): void {
    const t = token.trim();
    if (t) this.authenticate(t);
  }
  /** Forget the saved token and drop back to the auth gate. */
  signOut(): void {
    clearToken();
    this.settingsOpen = false;
    this.unauthorized = true;
    this.unauthorizedReason = "signed-out";
    disconnect();
  }
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    persistSidebarOpen(this.sidebarOpen);
  }
  closeSidebar(): void {
    this.sidebarOpen = false;
    persistSidebarOpen(false);
  }
  /** Open the drawer. Pair of closeSidebar; used by the left-edge swipe gesture. */
  openSidebar(): void {
    this.sidebarOpen = true;
    persistSidebarOpen(true);
  }
  /** Toggle the right context panel (flagged files + todos). */
  toggleRightSidebar(): void {
    this.rightSidebarOpen = !this.rightSidebarOpen;
  }
  closeRightSidebar(): void {
    this.rightSidebarOpen = false;
  }
  /** Flip the active-only ↔ all filter; persisted per-device. */
  toggleShowArchived(): void {
    this.showArchived = !this.showArchived;
    persistShowArchived(this.showArchived);
  }
  clearError(): void {
    this.lastError = null;
  }
  /** The config the composer's model/effort picker reflects: the draft's choices while
   *  drafting a new session, else the active session's live config. In draft mode the
   *  available thinking levels come from the chosen model's `thinkingLevels` (no session
   *  exists yet to report its own). */
  get composerConfig(): SessionConfig {
    const d = this.draft;
    if (!d) return this.session.config;
    const levels = d.model
      ? this.models.find(
          (m) =>
            m.provider === d.model?.provider && m.modelId === d.model?.modelId,
        )?.thinkingLevels
      : undefined;
    return {
      provider: d.model?.provider,
      modelId: d.model?.modelId,
      thinkingLevel: d.thinking,
      availableThinkingLevels: levels,
    };
  }
  setModel(provider: string, modelId: string): void {
    if (this.draft) {
      // Switching model can change supported thinking levels; clamp the draft's level
      // to the new model's set so the effort chip never shows an unsupported option.
      const levels = this.models.find(
        (m) => m.provider === provider && m.modelId === modelId,
      )?.thinkingLevels;
      const cur = this.draft.thinking;
      const thinking =
        levels && cur && !levels.includes(cur)
          ? levels.includes("medium")
            ? "medium"
            : levels[levels.length - 1]
          : cur;
      this.draft = { ...this.draft, model: { provider, modelId }, thinking };
      this.persistDraftConfig();
      return;
    }
    send({ type: "setModel", provider, modelId });
  }
  setThinking(level: string): void {
    if (this.draft) {
      this.draft = { ...this.draft, thinking: level };
      this.persistDraftConfig();
      return;
    }
    send({ type: "setThinking", level });
  }
  /** Switch the active facet (execute ↔ plan). Mid-session only — the facet is a
   *  property of an active session, not a new-session draft setting. */
  setFacet(facet: string): void {
    send({ type: "setFacet", facet });
  }

  /** Switch the active permission-monitor mode (standard/bypass/autonomous).
   *  Mid-session only — mirrors setFacet. */
  setPermissionMonitor(mode: PermissionMonitorMode): void {
    send({ type: "setPermissionMonitor", mode });
  }

  /** Toggle the adventurous auto-handoff flag (lets plan mode autonomously start
   *  implementing). The updated state arrives via the next snapshot. */
  toggleAdventurousHandoff(): void {
    send({ type: "toggleAdventurousHandoff" });
  }

  /** Set the notification auto-drain flag (autodrain non-blocking notifications). */
  setNotificationAutodrain(enabled: boolean): void {
    send({ type: "setNotificationAutodrain", enabled });
  }

  /** Models shown in the header picker: filtered to favorites when any are set, but the
   *  currently-active model is ALWAYS included — a running non-favorite model stays
   *  visible/selectable (option a). Empty favorites = show every available model. */
  get pickerModels(): ModelOption[] {
    const favs = this.modelDefaults.favorites;
    if (favs.length === 0) return this.models;
    const set = new Set(favs);
    const cfg = this.composerConfig;
    return this.models.filter(
      (m) =>
        set.has(`${m.provider}:${m.modelId}`) ||
        (m.provider === cfg.provider && m.modelId === cfg.modelId),
    );
  }
  isFavorite(provider: string, modelId: string): boolean {
    return this.modelDefaults.favorites.includes(`${provider}:${modelId}`);
  }

  /** Set (or clear, with null/empty) the login shell pilot captures env from at startup.
   *  Optimistic local update; the server persists + re-broadcasts. Applies on the next
   *  server restart — the Settings panel surfaces the pending-restart state. */
  setLoginShell(path: string | null): void {
    const next = path?.trim() ? path.trim() : null;
    this.pilotSettings = { ...this.pilotSettings, loginShell: next };
    send({ type: "setLoginShell", path: next });
  }
  /** Set (or clear, with null/empty) the background-model spec pilot's own extensions
   *  run their cheap out-of-band LLM calls against. Optimistic local update; the
   *  server persists + re-broadcasts (carrying the resolved `warning` for a bad spec).
   *  Clears `backgroundModelWarning` optimistically too so saving a good spec right
   *  after a bad one doesn't flash the stale red error until the broadcast lands. */
  setBackgroundModel(spec: string | null): void {
    const next = spec?.trim() ? spec.trim() : null;
    this.pilotSettings = { ...this.pilotSettings, backgroundModel: next };
    this.backgroundModelWarning = undefined;
    send({ type: "setBackgroundModel", spec: next });
  }
  refreshSessions(): void {
    send({ type: "listSessions" });
  }
  /** Archive or unarchive a session by path. Optimistic — flips the local flag now so
   *  the row reacts instantly; the server's `sessionList` re-broadcast reconciles. */
  /** Push a transient snackbar; auto-dismisses after `durationMs` (0 = sticky). */
  toast(
    message: string,
    opts?: { action?: { label: string; run: () => void }; durationMs?: number },
  ): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, message, action: opts?.action }];
    const ms = opts?.durationMs ?? 6000;
    if (ms > 0) setTimeout(() => this.dismissToast(id), ms);
  }
  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  setArchived(path: string, archived: boolean): void {
    this.sessions = this.sessions.map((s) =>
      s.path === path ? { ...s, archived } : s,
    );
    send({ type: "setArchived", path, archived });
    // Archiving is instant and pulls the row from view — offer a one-tap undo so a
    // misfire isn't a filter-toggle-then-hunt recovery. (Unarchive needs no toast.)
    if (archived) {
      const s = this.sessions.find((x) => x.path === path);
      const name = s?.displayName || s?.preview || "Session";
      const label = name.length > 32 ? `${name.slice(0, 31)}…` : name;
      // Archiving the session you're looking at: it would otherwise linger (pinned as the
      // viewed row) until you navigated away by hand. Flip into a new-session draft for the
      // same project so the row drops immediately and you land on a prompt page rather than
      // the just-archived transcript. A pilot worktree session's cwd may be reaped on
      // archive, so draft into the parent repo (`worktree.base`) instead of the dead dir.
      const viewedId = this.session.ref?.sessionId ?? this.activeSessionId;
      const archivingFocused = s != null && s.sessionId === viewedId;
      if (archivingFocused) this.startDraft(s.worktree?.base ?? s.cwd);
      this.toast(`Archived “${label}”`, {
        action: {
          label: "Undo",
          run: () => {
            this.setArchived(path, false);
            // Restore the prior view too, if archiving had navigated us into a draft.
            if (archivingFocused) this.openSession(path);
          },
        },
      });
    }
  }
  /** Rename a session by path. Optimistic — sets the local displayName now so the row
   *  (and, for the active session, the header) react instantly; the server's
   *  `sessionList` re-broadcast reconciles. Empty names are dropped (not a rename). */
  renameSession(path: string, name: string): void {
    const next = name.trim();
    if (!next) return;
    this.sessions = this.sessions.map((s) =>
      s.path === path ? { ...s, displayName: next } : s,
    );
    send({ type: "renameSession", path, name: next });
  }
  /** Remove a pilot-created worktree (by its path == the session cwd). `force` discards
   *  uncommitted changes. The server re-broadcasts the list, clearing the indicator. */
  cleanupWorktree(path: string, force = false): void {
    send({ type: "cleanupWorktree", path, force });
  }
  /** Reload a session from scratch (by its .jsonl path): the server disposes the warm
   *  session and re-warms it from disk, rebuilding the agent's context anew (config + extensions
   *  loaded fresh). The recovery path for a session an extension bug has wedged — fix the
   *  extension elsewhere, then reload here. The server re-seeds every client viewing it. */
  reloadSession(path: string): void {
    send({ type: "reloadSession", path });
  }
  /** Copy text to the clipboard (worktree path, session id, …). Returns whether it
   *  succeeded so the caller can flash feedback; degrades quietly where the clipboard
   *  API is unavailable (insecure context / older browser). */
  async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      this.lastError = "couldn't copy to clipboard (needs a secure context)";
      return false;
    }
  }
  /** Copy the server's data directory path to the clipboard. The path is already known
   *  to this client (from `hello`), so this is a local copy — no server round-trip.
   *  Returns whether it succeeded so the caller can flash feedback. */
  async copyDataDirPath(): Promise<boolean> {
    if (!this.dataDir) return false;
    return this.copyToClipboard(this.dataDir);
  }
  /** Ask the server to reveal its data directory in the platform file manager
   *  (Finder on macOS). The client can't spawn processes, so this goes over the WS as
   *  an `openDataDir` message; a headless/remote host answers with an `error`. */
  openDataDir(): void {
    if (!this.dataDir) return;
    send({ type: "openDataDir" });
  }
  get activeSessionPath(): string | null {
    return (
      this.sessions.find((s) => s.sessionId === this.activeSessionId)?.path ??
      null
    );
  }
  /** Dev/verification: register this device for push, then trigger a server test push. */
  async testPush(): Promise<void> {
    this.pushState = await ensurePushSubscription();
    await sendTestPush();
  }
}

const SIDEBAR_KEY = "pilot.sidebarOpen";

/** Matches a lease-conflict (409) error message from classifySwitchError. The
 *  classified message is either the full claimLease text ("another TUI is
 *  attached…") or the fallback ("…lease to lapse."). Both branches match, so the
 *  client's Retry toast fires on either path without a wire-protocol change. */
const LEASE_CONFLICT_RE = /another TUI is attached|lease to lapse/;

/** Default the sidebar open on a desktop-width viewport, closed on a phone (where
 *  it's a drawer); a stored preference wins. Guarded for SSR/test environments. */
function initialSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(SIDEBAR_KEY);
  if (stored !== null) return stored === "1";
  return window.matchMedia("(min-width: 860px)").matches;
}

function persistSidebarOpen(open: boolean): void {
  if (typeof window !== "undefined")
    localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
}

const SHOW_ARCHIVED_KEY = "pilot.showArchived";

/** Default the sidebar filter to active-only; a stored preference wins. */
function initialShowArchived(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(SHOW_ARCHIVED_KEY) === "1";
}

function persistShowArchived(show: boolean): void {
  if (typeof window !== "undefined")
    localStorage.setItem(SHOW_ARCHIVED_KEY, show ? "1" : "0");
}

const HIDE_THINKING_KEY = "pilot.hideThinking";

/** Default to HIDING thinking blocks (the owner's call): the reasoning stream is noise
 *  for most reading, and the composer's "Thinking…" indicator still signals activity.
 *  A stored preference (either direction) wins. */
function initialHideThinking(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(HIDE_THINKING_KEY);
  if (stored !== null) return stored === "1";
  return true;
}

function persistHideThinking(hide: boolean): void {
  if (typeof window !== "undefined")
    localStorage.setItem(HIDE_THINKING_KEY, hide ? "1" : "0");
}

const DRAFTS_KEY = "pilot.composerDrafts";
const DRAFT_CONFIG_KEY = "pilot.draftConfig";
const LAST_SESSION_PREFIX = "pilot.lastSession.";
const LAST_SERVER_KEY = "pilot.lastServerId";

const LAST_PROJECT_CWD_KEY = "pilot.lastProjectCwd";

function loadLastProjectCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(LAST_PROJECT_CWD_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistLastProjectCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_PROJECT_CWD_KEY, cwd);
  } catch {
    // Best effort — only affects ⌘N's default on a cold landing.
  }
}

function loadLastServerId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LAST_SERVER_KEY);
  } catch {
    return null;
  }
}

function persistLastServerId(serverId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAST_SERVER_KEY, serverId);
  } catch {
    // Best effort — this only enables pre-hello recovery after a reload.
  }
}

function createPromptId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestedSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("session");
}

function clearRequestedSession(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("session")) return;
  url.searchParams.delete("session");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function lastSessionKey(serverId: string): string {
  return `${LAST_SESSION_PREFIX}${serverId}`;
}

function loadLastSession(serverId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(lastSessionKey(serverId));
  } catch {
    return null;
  }
}

function persistLastSession(serverId: string, sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(lastSessionKey(serverId), sessionId);
  } catch {
    // Storage unavailable (private mode) — focus simply lasts for this page load.
  }
}

function clearLastSession(serverId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(lastSessionKey(serverId));
  } catch {
    // Best effort: a stale preference is harmless and retried on the next boot.
  }
}

/** Read the per-session composer drafts map from localStorage. Tolerant of a missing /
 *  corrupt value (returns an empty map) — a lost draft is never worth a thrown boot. */
function loadDraftMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function persistDraftMap(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(map));
  } catch {
    // Storage full / unavailable (private mode) — drafts stay in-memory this session.
  }
}

/** Persisted per-new-session-draft config not carried by the composer text: the worktree
 *  toggle plus an explicit model/thinking override. Keyed `n:<cwd>` in draftConfigMap. Every
 *  field is optional — absence means "fall back to the global default at draft-open". */
type StoredDraftConfig = {
  worktree?: boolean;
  model?: { provider: string; modelId: string };
  thinking?: string;
};

/** Read per-new-session-draft config from localStorage. Tolerant of a missing / corrupt
 *  value — a lost draft config is never worth a thrown boot. Each field is validated and
 *  kept only when well-formed; an entry left with nothing is dropped. */
function loadDraftConfigMap(): Record<string, StoredDraftConfig> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(DRAFT_CONFIG_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, StoredDraftConfig> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const rec = v as {
        worktree?: unknown;
        model?: unknown;
        thinking?: unknown;
      };
      const cfg: StoredDraftConfig = {};
      if (rec.worktree === true) cfg.worktree = true;
      const m = rec.model as { provider?: unknown; modelId?: unknown } | null;
      if (m && typeof m.provider === "string" && typeof m.modelId === "string")
        cfg.model = { provider: m.provider, modelId: m.modelId };
      if (typeof rec.thinking === "string") cfg.thinking = rec.thinking;
      if (cfg.worktree || cfg.model || cfg.thinking) out[k] = cfg;
    }
    return out;
  } catch {
    return {};
  }
}

function persistDraftConfigMap(map: Record<string, StoredDraftConfig>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DRAFT_CONFIG_KEY, JSON.stringify(map));
  } catch {
    // Storage full / unavailable (private mode) — draft config stays in-memory this session.
  }
}

const PROMPT_HISTORY_KEY = "pilot.promptHistory";
// Per-key cap on the submit log. Plenty for recall; bounds localStorage growth (the
// navigable list is padded further by the transcript, which is server-side anyway).
const PROMPT_HISTORY_CAP = 100;

/** Read the per-session prompt submit log from localStorage. Tolerant of a missing /
 *  corrupt value (returns an empty map) — lost recall history is never worth a thrown boot. */
function loadPromptHistory(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PROMPT_HISTORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (Array.isArray(v))
        out[k] = v.filter((x): x is string => typeof x === "string");
    return out;
  } catch {
    return {};
  }
}

function persistPromptHistory(map: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(map));
  } catch {
    // Storage full / unavailable (private mode) — history stays in-memory this session.
  }
}

export const store = new PilotStore();

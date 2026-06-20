// The client store: holds a reactive SessionState, adopts server snapshots, and
// folds incremental events with the SAME reducer the server runs. Per-client view
// state (composer draft) lives here too and is intentionally never sent upstream.

import {
  type CommandInfo,
  type FileInfo,
  foldEvent,
  type HostUiResponse,
  type ImageContent,
  initialSessionState,
  type ModelDefaults,
  type ModelOption,
  type OAuthDeviceInfo,
  type OAuthLoginPrompt,
  type ProviderInfo,
  type ServerMessage,
  type SessionAttention,
  type SessionConfig,
  type SessionListEntry,
  type SessionState,
  type TranscriptItem,
  type TrustRequest,
} from "@pilot/protocol";
import { clearToken, getToken, setToken } from "./auth.js";
import { ensurePermission } from "./notify.js";
import {
  applyThemeMode,
  getThemeMode,
  setThemeMode,
  type ThemeMode,
  watchSystemTheme,
} from "./theme.js";
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

class PilotStore {
  session = $state<SessionState>(initialSessionState());
  serverId = $state<string | null>(loadLastServerId());
  ready = $state(false);
  unauthorized = $state(false);

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
  // File paths matching the current @-mention query, for the composer's file
  // autocomplete. Fetched on demand per-keystroke (debounced client-side ~150ms);
  // the server echoes the query so we can drop stale responses. See `queryFiles()`.
  files = $state<{ query: string; items: readonly FileInfo[] }>({
    query: "",
    items: [],
  });
  // Interactive project-trust card (D12). Out-of-band, not part of the folded session
  // state: trust is decided per-cwd before a session exists. Null when none pending.
  trustRequest = $state<TrustRequest | null>(null);
  // Settings panel: the providers pilot can manage credentials for, and pi's global
  // model defaults + favorites. Server-authoritative, delivered like `models`.
  providers = $state<ProviderInfo[]>([]);
  modelDefaults = $state<ModelDefaults>({ favorites: [] });
  // OAuth sign-in flow (Settings panel). Global + interactive like `trustRequest` —
  // not part of the folded session state. Null when no login is running. `progress`
  // accumulates status lines; `prompt` is the step awaiting the operator (open the URL,
  // paste the code), `device` the device-code variant; `done`/`error` end the flow. Only
  // the client that started the login renders it (a single-user app drives from one tab).
  oauthFlow = $state<{
    providerId: string;
    progress: string[];
    prompt: (OAuthLoginPrompt & { requestId: string }) | null;
    device: OAuthDeviceInfo | null;
    done: boolean;
    error: string | null;
  } | null>(null);

  // per-client view state — local only (never sent upstream; see D5)
  composerDraft = $state("");
  composerImages = $state<ImageContent[]>([]);
  // Durable client outbox. Entries remain until the server explicitly ACKs pi's prompt
  // preflight; reconnect/reload resends queued entries by stable promptId.
  pendingPrompts = $state<PendingPrompt[]>([]);
  private hydratedOutboxServerId: string | null = null;
  // Per-session (and per new-session-draft) unsent prompt text, persisted in localStorage
  // so switching sessions — or reloading — preserves whatever you were typing. Keyed by
  // `s:<sessionId>` for an existing session and `n:<cwd>` for a pending new-session draft
  // (up to one per project). The live edit lives in `composerDraft`; this map is the
  // durable backing store, stashed on switch / debounced keystroke / pagehide. Pure client
  // state — no protocol change.
  private draftMap: Record<string, string> = loadDraftMap();
  // New-session draft (Claude-app style): when non-null the main pane shows the
  // config chips + composer for a session that does NOT exist yet. Creation is
  // deferred — submitDraft() sends `newSession` (cwd/worktree/model/thinking + the
  // first prompt) atomically, so nothing hits the server until the user sends.
  draft = $state<{
    cwd: string;
    worktree: boolean;
    model?: { provider: string; modelId: string };
    thinking?: string;
  } | null>(null);
  // Sidebar open/collapsed. Default open on a roomy viewport, closed on a phone
  // (where it's an overlay drawer). Persisted per-device in localStorage.
  sidebarOpen = $state(initialSidebarOpen());
  // Sidebar filter: false = active only (hide archived + sessions untouched >7d),
  // true = show everything. Per-device, persisted in localStorage; defaults to
  // active-only (the decluttering is the point).
  showArchived = $state(initialShowArchived());
  // Last server-side error worth showing the user (e.g. a session switch to a bad
  // path failed). Transient — cleared on the next successful switch or by the UI.
  lastError = $state<string | null>(null);
  // Push subscription status for this device. "working" while a subscribe is in flight.
  pushState = $state<PushState | "working">("idle");
  // Settings panel open/closed — per-client view state, never sent upstream.
  settingsOpen = $state(false);
  // Theme override (system/light/dark), persisted per-device in localStorage.
  themeMode = $state<ThemeMode>(getThemeMode());
  // Hide thinking blocks toggle — when on, thinking content is replaced with a
  // subtle non-expandable placeholder. Persisted per-device in localStorage.
  hideThinking = $state(initialHideThinking());
  // PWA: a newer service worker installed and is ready; we prompt for a refresh.
  swUpdateReady = $state(false);
  // Desktop app: a new origin/main is staged on the server's clone but deferred because
  // we're connected (server-pushed via `updateStatus`). Drives the sidebar update card;
  // `applying` is true between clicking "update now" and the server restarting. Distinct
  // from `swUpdateReady` (that's the PWA asset-cache refresh).
  appUpdate = $state<{ sha: string; applying: boolean } | null>(null);
  // The last prompt text sent — lets the run-failed error card re-send it on Retry.
  lastPrompt = $state("");
  // Global hotkey dispatch — incremented so $effect catches every keystroke.
  hotkeyAction = $state<{ which: "model" | "thinking"; n: number } | null>(
    null,
  );
  // Bump to ask the composer textarea to retake focus — e.g. after the model/effort
  // menu closes from a keyboard-driven flow. A counter so each request re-fires.
  focusComposerN = $state(0);

  focusComposer(): void {
    this.focusComposerN++;
  }

  /** The localStorage key the current composer text belongs to: the new-session draft's
   *  project while drafting, else the focused/active session. */
  private get composerDraftKey(): string {
    if (this.draft) return `n:${this.draft.cwd.trim() || "~"}`;
    const id = this.session.ref?.sessionId ?? this.activeSessionId;
    return id ? `s:${id}` : "none";
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
      .map(
        (prompt): TranscriptItem => ({
          kind: "user",
          id: prompt.promptId,
          text: prompt.text,
          images: prompt.images,
          ts: prompt.createdAt,
          delivery:
            prompt.state === "rejected"
              ? "rejected"
              : this.connection === "connected" && prompt.state === "sending"
                ? "sending"
                : "offline",
          deliveryError: prompt.error,
        }),
      );
    return [...this.session.items, ...optimistic];
  }
  /** True when a turn is in flight for the FOCUSED session — the robust signal that
   *  drives the stop pill, the working indicator, and the composer's steer/queue mode.
   *
   *  The folded `session.status` alone is NOT enough: it only changes on snapshot-
   *  bearing events, while raw deltas/tool events never touch it. An out-of-band
   *  re-snapshot mid-turn (a rename / model change while a tool runs, when pi's
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
  }

  async refreshPushState(): Promise<void> {
    this.pushState = await currentPushState();
  }

  /** Explicit user-gesture enable (the header bell). Reports the outcome via pushState. */
  async enablePush(): Promise<void> {
    this.pushState = "working";
    this.pushState = await ensurePushSubscription();
  }

  private onServer(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        this.serverId = msg.serverId;
        persistLastServerId(msg.serverId);
        void this.hydrateOutbox(msg.serverId);
        break;
      case "snapshot":
        this.session = msg.state;
        this.ready = true;
        if (this.bootRestoreInFlight && msg.state.ref)
          this.bootRestoreInFlight = false;
        // A snapshot lands after a successful switch — clear any stale switch error.
        this.lastError = null;
        this.maybeOpenBootDraft();
        // Dev-only: time how long this full transcript render takes. The signal for
        // "is it time to build JS windowing?" (see docs/DESIGN.md).
        this.logRenderTiming(msg.state.items.length);
        break;
      case "event":
        foldEvent(this.session, msg.event);
        break;
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
      case "fileList":
        this.files = { query: msg.query, items: [...msg.files] };
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
      case "providerList":
        this.providers = [...msg.providers];
        break;
      case "modelDefaults":
        this.modelDefaults = msg.defaults;
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
        break;
      case "oauthPrompt":
        // Ignore prompts for a flow this client didn't start (or already closed).
        if (this.oauthFlow?.providerId === msg.providerId)
          this.oauthFlow = {
            ...this.oauthFlow,
            prompt: { requestId: msg.requestId, ...msg.prompt },
            device: null,
          };
        break;
      case "oauthProgress":
        if (this.oauthFlow?.providerId === msg.providerId)
          this.oauthFlow = {
            ...this.oauthFlow,
            progress: [...this.oauthFlow.progress, msg.message],
          };
        break;
      case "oauthDeviceCode":
        if (this.oauthFlow?.providerId === msg.providerId)
          this.oauthFlow = {
            ...this.oauthFlow,
            device: {
              userCode: msg.userCode,
              verificationUri: msg.verificationUri,
              expiresInSeconds: msg.expiresInSeconds,
            },
          };
        break;
      case "oauthResolved":
        if (this.oauthFlow?.prompt?.requestId === msg.requestId)
          this.oauthFlow = { ...this.oauthFlow, prompt: null };
        break;
      case "oauthResult":
        if (this.oauthFlow?.providerId === msg.providerId)
          this.oauthFlow = {
            ...this.oauthFlow,
            prompt: null,
            device: null,
            done: true,
            error: msg.ok ? null : (msg.error ?? "OAuth login failed"),
          };
        break;
      case "error":
        if (msg.message === "unauthorized") {
          this.unauthorized = true;
          disconnect(); // stop the reconnect loop until a new token is entered
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
    }
  }

  /** Save a token and reconnect (from the auth gate). */
  authenticate(token: string): void {
    setToken(token);
    this.unauthorized = false;
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
    const prompt = this.pendingPrompts.find((item) => item.promptId === promptId);
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

  private async enqueuePrompt(
    prompt: Omit<PendingPrompt, "promptId" | "serverId" | "createdAt" | "state">,
  ): Promise<boolean> {
    const serverId = this.serverId ?? loadLastServerId();
    if (!serverId) {
      this.lastError = "Still connecting — your prompt is still in the composer.";
      return false;
    }
    // This is the IndexedDB structured-clone boundary. Svelte `$state` values may be
    // proxies (draft model/options and composer images both originate in reactive state),
    // which IDB refuses to clone. Rebuild every nested field as plain data here so all
    // callers—including future ones—get the same durable behavior.
    const pending: PendingPrompt = {
      kind: prompt.kind,
      text: prompt.text,
      images: prompt.images?.map(({ type, data, mimeType }) => ({
        type,
        data,
        mimeType,
      })),
      deliverAs: prompt.deliverAs,
      sessionId: prompt.sessionId,
      newSession: prompt.newSession
        ? {
            cwd: prompt.newSession.cwd,
            worktree: prompt.newSession.worktree,
            model: prompt.newSession.model
              ? {
                  provider: prompt.newSession.model.provider,
                  modelId: prompt.newSession.model.modelId,
                }
              : undefined,
            thinking: prompt.newSession.thinking,
          }
        : undefined,
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
      return false;
    }
    this.pendingPrompts = [...this.pendingPrompts, pending];
    this.sendPendingPrompt(pending.promptId);
    return true;
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

  async prompt(
    text: string,
    deliverAs?: "steer" | "followUp",
    images?: ImageContent[],
  ): Promise<boolean> {
    const t = text.trim();
    if (!t && (!images || images.length === 0)) return false;
    this.lastPrompt = t;
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
    // The draft was consumed — clear the live text AND its stored copy.
    this.clearStoredDraft(this.composerDraftKey);
    this.composerDraft = "";
    this.composerImages = [];
    return true;
  }
  abort(): void {
    send({ type: "abort" });
  }
  /** Pi-parity dequeue: atomically clear every steer/follow-up and return it here. */
  restoreQueue(): void {
    if (!send({ type: "restoreQueue" }))
      this.lastError = "Can't restore queued messages while offline.";
  }
  /** Apply the staged desktop update now (the sidebar card's button). The server marks
   *  it applying; the watcher pulls/rebuilds/restarts and the card clears on reconnect. */
  requestAppUpdate(): void {
    send({ type: "applyUpdate" });
  }
  /** Re-send the last prompt after a run-failed (the error card's Retry). */
  retryLast(): void {
    if (this.lastPrompt) void this.prompt(this.lastPrompt);
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
   *  from the Composer on each keystroke after `@`. */
  queryFiles(query: string): void {
    send({ type: "queryFiles", query });
  }
  /** Jump the session to a prior tree entry and branch from it (pi's /tree). The server
   *  re-seeds every client's transcript to the new branch; if `entryId` was a user
   *  prompt, this client also gets an `editorPrefill` with its text. No-op while a turn
   *  is running (the server rejects it — a mid-turn navigate would corrupt the branch). */
  branch(entryId: string): void {
    if (this.turnActive) return;
    send({ type: "branch", entryId });
  }
  /** Branch from the most recent user prompt — the "edit & resend my last message"
   *  gesture, bound to a global hotkey. Finds the last user item carrying a branch
   *  handle and branches from it. */
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
    const id = this.sessions.find((s) => s.path === path)?.sessionId;
    // Restore the target's saved draft into the composer (empty if none).
    this.loadDraft(id ? `s:${id}` : "none");
    // Same session (e.g. tapped the active row while drafting) — we've exited the draft
    // and restored its text; nothing to switch.
    if (!switching) return;
    // Optimistic: opening a session reads it (the authoritative clear also rides the
    // next `sessionList`, but this avoids a flicker of the unread dot mid-switch).
    if (id) this.markRead(id);
    // A switched-to session renders at the bottom — clear any stale below-fold flag.
    this.clearActiveUnread();
    // Drop the @-mention file cache: it's keyed only by query string, so the new
    // session's cwd would otherwise show the prior cwd's files until the next
    // `queryFiles` round-trips. The empty-query entry is the one that bites — it
    // matches instantly when the user types `@`.
    this.files = { query: "", items: [] };
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
   *  transcript otherwise renders every item up front (no virtualization) since CSS
   *  `content-visibility` was removed (it drifted the viewport while scrolling up). */
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
    if (attention?.phase === "done" && this.unread.has(sessionId)) return "done";
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
      return attention.activity ? `Failed · ${attention.activity}` : "Run failed";
    if (attention.phase === "running")
      return attention.activity ?? "Working";
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
      // doesn't lose a half-typed prompt.
      this.loadDraft(`s:${this.activeSessionId}`);
    }
  }

  /** Open the new-session draft. `cwd` prefills the project (the sidebar passes the
   *  group's cwd, or the active session's). Model/thinking seed from pi's global
   *  defaults so the chips reflect what a plain new session would use. */
  startDraft(cwd = ""): void {
    // Save whatever session/draft we're leaving before flipping into the new draft.
    this.stashDraft();
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
  }
  cancelDraft(): void {
    // Keep the new-session draft for next time, then drop back to the active session's draft.
    this.stashDraft();
    this.draft = null;
    this.loadDraft(this.composerDraftKey);
  }
  setDraftCwd(cwd: string): void {
    if (this.draft) this.draft = { ...this.draft, cwd };
  }
  toggleDraftWorktree(): void {
    if (this.draft)
      this.draft = { ...this.draft, worktree: !this.draft.worktree };
  }
  /** Commit the draft: create the session and deliver its first prompt in one
   *  message. Mirrors prompt()'s permission/push gesture since this IS the first turn. */
  async submitDraft(
    text: string,
    images?: ImageContent[],
  ): Promise<boolean> {
    const d = this.draft;
    if (!d) return false;
    const t = text.trim();
    if (!t && (!images || images.length === 0)) return false;
    this.lastPrompt = t;
    ensurePermission();
    void ensurePushSubscription().then((s) => {
      this.pushState = s;
    });
    const queued = await this.enqueuePrompt({
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
    if (!queued) return false;
    // The pending new-session draft is consumed — drop its stored copy (key is n:cwd
    // while the draft is still set).
    this.clearStoredDraft(this.composerDraftKey);
    this.draft = null;
    this.composerDraft = "";
    this.composerImages = [];
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
      return;
    }
    send({ type: "setModel", provider, modelId });
  }
  setThinking(level: string): void {
    if (this.draft) {
      this.draft = { ...this.draft, thinking: level };
      return;
    }
    send({ type: "setThinking", level });
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

  // --- Settings panel: provider credentials + global model defaults/favorites. ---
  setProviderApiKey(providerId: string, apiKey: string): void {
    send({ type: "setProviderApiKey", providerId, apiKey });
  }
  removeProviderApiKey(providerId: string): void {
    send({ type: "removeProviderApiKey", providerId });
  }
  /** Start an OAuth sign-in. Opens the local flow (so this client renders the prompts
   *  the server will broadcast back) and asks the server to drive it. */
  oauthLogin(providerId: string): void {
    this.oauthFlow = {
      providerId,
      progress: [],
      prompt: null,
      device: null,
      done: false,
      error: null,
    };
    send({ type: "oauthLogin", providerId });
  }
  /** Answer the current OAuth prompt (pasted code/URL, or a selected option id).
   *  Optimistically clears the prompt; the server's `oauthResolved` confirms. */
  oauthRespond(value: string): void {
    const p = this.oauthFlow?.prompt;
    if (!p || !this.oauthFlow) return;
    send({ type: "oauthRespond", requestId: p.requestId, value });
    this.oauthFlow = { ...this.oauthFlow, prompt: null };
  }
  /** Cancel an in-progress login: tell the server to abort the pending prompt (which
   *  fails the login server-side), then close the local flow. */
  oauthCancel(): void {
    const p = this.oauthFlow?.prompt;
    if (p) send({ type: "oauthRespond", requestId: p.requestId, value: null });
    this.oauthFlow = null;
  }
  /** Dismiss a finished (done/errored) OAuth flow. */
  closeOauth(): void {
    this.oauthFlow = null;
  }
  /** Sign out of an OAuth provider (clears its stored credentials server-side). */
  oauthLogout(providerId: string): void {
    send({ type: "oauthLogout", providerId });
  }
  /** Set the global default model for new sessions (optimistic; server reconciles). */
  setDefaultModel(provider: string, modelId: string): void {
    this.modelDefaults = { ...this.modelDefaults, provider, modelId };
    send({ type: "setDefaultModel", provider, modelId });
  }
  setDefaultThinking(level: string): void {
    this.modelDefaults = { ...this.modelDefaults, thinkingLevel: level };
    send({ type: "setDefaultThinking", level });
  }
  /** Toggle a model in the favorites subset. Optimistic; the server's `modelDefaults`
   *  broadcast (resolved against available models) is the source of truth. */
  toggleFavorite(provider: string, modelId: string): void {
    const ref = `${provider}:${modelId}`;
    const cur = this.modelDefaults.favorites;
    const next = cur.includes(ref)
      ? cur.filter((r) => r !== ref)
      : [...cur, ref];
    this.modelDefaults = { ...this.modelDefaults, favorites: next };
    send({ type: "setFavoriteModels", refs: next });
  }
  refreshSessions(): void {
    send({ type: "listSessions" });
  }
  /** Archive or unarchive a session by path. Optimistic — flips the local flag now so
   *  the row reacts instantly; the server's `sessionList` re-broadcast reconciles. */
  setArchived(path: string, archived: boolean): void {
    this.sessions = this.sessions.map((s) =>
      s.path === path ? { ...s, archived } : s,
    );
    send({ type: "setArchived", path, archived });
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
  /** Copy a worktree's path to the clipboard. Returns whether it succeeded so the
   *  caller can flash feedback; degrades quietly where the clipboard API is unavailable
   *  (insecure context / older browser). */
  async copyWorktreePath(path: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(path);
      return true;
    } catch {
      this.lastError = "couldn't copy to clipboard (needs a secure context)";
      return false;
    }
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
const LAST_SESSION_PREFIX = "pilot.lastSession.";
const LAST_SERVER_KEY = "pilot.lastServerId";

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

export const store = new PilotStore();

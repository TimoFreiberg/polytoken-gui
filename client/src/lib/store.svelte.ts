// The client store: holds a reactive SessionState, adopts server snapshots, and
// folds incremental events with the SAME reducer the server runs. Per-client view
// state (composer draft) lives here too and is intentionally never sent upstream.

import {
  type CommandInfo,
  foldEvent,
  type HostUiResponse,
  initialSessionState,
  type ModelDefaults,
  type ModelOption,
  type ProviderInfo,
  type ServerMessage,
  type SessionListEntry,
  type SessionState,
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
  connect,
  type ConnectionState,
  connectionState,
  disconnect,
  onMessage,
  send,
} from "./ws.svelte.js";

class PilotStore {
  session = $state<SessionState>(initialSessionState());
  serverId = $state<string | null>(null);
  ready = $state(false);
  unauthorized = $state(false);

  // Session picker — server-authoritative: the sessions on disk + which is active.
  sessions = $state<SessionListEntry[]>([]);
  activeSessionId = $state<string | null>(null);
  // Session ids with a live turn right now (server-pushed via `sessionStatus`).
  runningIds = $state<Set<string>>(new Set());
  // Sessions with new content since last viewed. GUI-only, in-memory: a session is
  // marked unread when a *background* turn of it finishes (running→done while it's
  // not the active session); cleared when it becomes active. Everything starts read
  // on page load (no persistence) — matches the TODO's "old sessions default to read".
  unread = $state<Set<string>>(new Set());
  // Model picker — the models available to switch to (current selection lives in
  // session.config). Server-authoritative, delivered like `sessions`.
  models = $state<ModelOption[]>([]);
  // Slash commands the focused session offers, for the composer typeahead. Server-
  // authoritative, delivered like `models`; refreshed on session switch (cwd-scoped).
  commands = $state<CommandInfo[]>([]);
  // Interactive project-trust card (D12). Out-of-band, not part of the folded session
  // state: trust is decided per-cwd before a session exists. Null when none pending.
  trustRequest = $state<TrustRequest | null>(null);
  // Settings panel: the providers pilot can manage credentials for, and pi's global
  // model defaults + favorites. Server-authoritative, delivered like `models`.
  providers = $state<ProviderInfo[]>([]);
  modelDefaults = $state<ModelDefaults>({ favorites: [] });

  // per-client view state — local only (never sent upstream; see D5)
  composerDraft = $state("");
  // Sidebar open/collapsed. Default open on a roomy viewport, closed on a phone
  // (where it's an overlay drawer). Persisted per-device in localStorage.
  sidebarOpen = $state(initialSidebarOpen());
  // Last server-side error worth showing the user (e.g. a session switch to a bad
  // path failed). Transient — cleared on the next successful switch or by the UI.
  lastError = $state<string | null>(null);
  // Push subscription status for this device. "working" while a subscribe is in flight.
  pushState = $state<PushState | "working">("idle");
  // Settings panel open/closed — per-client view state, never sent upstream.
  settingsOpen = $state(false);
  // Theme override (system/light/dark), persisted per-device in localStorage.
  themeMode = $state<ThemeMode>(getThemeMode());
  // PWA: a newer service worker installed and is ready; we prompt for a refresh.
  swUpdateReady = $state(false);
  // The last prompt text sent — lets the run-failed error card re-send it on Retry.
  lastPrompt = $state("");
  // Global hotkey dispatch — incremented so $effect catches every keystroke.
  hotkeyAction = $state<{ which: "model" | "thinking"; n: number } | null>(
    null,
  );

  get connection(): ConnectionState {
    return connectionState();
  }
  get streaming(): boolean {
    return this.session.status === "running";
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
        break;
      case "snapshot":
        this.session = msg.state;
        this.ready = true;
        // A snapshot lands after a successful switch — clear any stale switch error.
        this.lastError = null;
        break;
      case "event":
        foldEvent(this.session, msg.event);
        break;
      case "sessionList":
        this.sessions = [...msg.sessions];
        this.activeSessionId = msg.activeSessionId;
        // The session you're now viewing can't be unread.
        if (msg.activeSessionId) this.markRead(msg.activeSessionId);
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
      case "error":
        if (msg.message === "unauthorized") {
          this.unauthorized = true;
          disconnect(); // stop the reconnect loop until a new token is entered
        } else {
          console.error("[server error]", msg.message);
          this.lastError = msg.message;
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

  prompt(text: string, deliverAs?: "steer" | "followUp"): void {
    const t = text.trim();
    if (!t) return;
    this.lastPrompt = t;
    // This call is a user gesture — the moment to ask for notification permission
    // (tab-open path) and register a Web Push subscription (closed-phone path).
    ensurePermission();
    void ensurePushSubscription().then((s) => {
      this.pushState = s;
    });
    send({ type: "prompt", text: t, deliverAs });
    this.composerDraft = "";
  }
  abort(): void {
    send({ type: "abort" });
  }
  /** Re-send the last prompt after a run-failed (the error card's Retry). */
  retryLast(): void {
    if (this.lastPrompt) this.prompt(this.lastPrompt);
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
  openSession(path: string): void {
    if (path === this.activeSessionPath) return;
    // Optimistic: opening a session reads it (the authoritative clear also rides the
    // next `sessionList`, but this avoids a flicker of the unread dot mid-switch).
    const id = this.sessions.find((s) => s.path === path)?.sessionId;
    if (id) this.markRead(id);
    send({ type: "openSession", path });
  }
  private markRead(sessionId: string): void {
    if (!this.unread.has(sessionId)) return;
    const next = new Set(this.unread);
    next.delete(sessionId);
    this.unread = next;
  }
  /** The sidebar indicator for a session: a live turn, new-since-viewed, or idle. */
  sessionStatus(sessionId: string): "running" | "unread" | "read" {
    if (this.runningIds.has(sessionId)) return "running";
    if (this.unread.has(sessionId)) return "unread";
    return "read";
  }
  /** True if any session in a project group is running (collapsed-group indicator). */
  groupRunning(sessionIds: readonly string[]): boolean {
    return sessionIds.some((id) => this.runningIds.has(id));
  }
  newSession(cwd?: string, worktree?: boolean): void {
    send({ type: "newSession", cwd: cwd?.trim() || undefined, worktree });
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
  clearError(): void {
    this.lastError = null;
  }
  setModel(provider: string, modelId: string): void {
    send({ type: "setModel", provider, modelId });
  }
  setThinking(level: string): void {
    send({ type: "setThinking", level });
  }

  /** Models shown in the header picker: filtered to favorites when any are set, but the
   *  currently-active model is ALWAYS included — a running non-favorite model stays
   *  visible/selectable (option a). Empty favorites = show every available model. */
  get pickerModels(): ModelOption[] {
    const favs = this.modelDefaults.favorites;
    if (favs.length === 0) return this.models;
    const set = new Set(favs);
    const cfg = this.session.config;
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

export const store = new PilotStore();

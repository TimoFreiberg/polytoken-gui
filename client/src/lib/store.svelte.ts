// The client store: holds a reactive SessionState, adopts server snapshots, and
// folds incremental events with the SAME reducer the server runs. Per-client view
// state (composer draft) lives here too and is intentionally never sent upstream.

import {
  foldEvent,
  type HostUiResponse,
  initialSessionState,
  type ModelOption,
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
  // Model picker — the models available to switch to (current selection lives in
  // session.config). Server-authoritative, delivered like `sessions`.
  models = $state<ModelOption[]>([]);
  // Interactive project-trust card (D12). Out-of-band, not part of the folded session
  // state: trust is decided per-cwd before a session exists. Null when none pending.
  trustRequest = $state<TrustRequest | null>(null);

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
        break;
      case "modelList":
        this.models = [...msg.models];
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
    send({ type: "openSession", path });
  }
  newSession(cwd?: string): void {
    send({ type: "newSession", cwd: cwd?.trim() || undefined });
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

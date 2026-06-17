// Replays deterministic fixture scripts as a PilotDriver. Stands in for a real pi
// session so the whole UI pipeline can be built and screenshot-verified without a
// live model or API keys.

import type {
  CommandInfo,
  HostUiResponse,
  ModelDefaults,
  ModelOption,
  ProviderInfo,
  SessionConfig,
  SessionDriverEvent,
  SessionListEntry,
} from "@pilot/protocol";
import type { PilotDriver, TrustEvent } from "./driver.js";
import {
  ambient,
  bgRun,
  confirmDialog,
  editDiff,
  errorRun,
  greeting,
  idleNoComplete,
  inputDialog,
  MOCK_COMMANDS,
  MOCK_DEFAULT_CONFIG,
  MOCK_MODEL_DEFAULTS,
  MOCK_MODELS,
  MOCK_PROVIDERS,
  mockSessionSeed,
  mockTrustRequest,
  NEW_SESSION_ENTRY,
  newSessionSeed,
  promptReply,
  type ScriptStep,
  SESSION_LIST,
  SESSION_REF,
  snapshot,
  streamHold,
  timeoutConfirm,
  yesNoSelect,
} from "./fixtures.js";

export class MockDriver implements PilotDriver {
  private listeners = new Set<(ev: SessionDriverEvent) => void>();
  private trustListeners = new Set<(ev: TrustEvent) => void>();
  private pendingTrust = new Set<string>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pendingDialogs = new Set<string>();
  private sessions: SessionListEntry[] = SESSION_LIST.map((s) => ({ ...s }));
  // The mock's current model selection, mutated by setModel/setThinking so the picker
  // reflects a switch. (Scripted replies still emit the fixture default — fine for a
  // deterministic mock; the picker is exercised on its own.)
  private config: SessionConfig = { ...MOCK_DEFAULT_CONFIG };
  // Global config the Settings panel edits (providers + defaults/favorites). In-memory
  // only; the hub re-reads via list* after each mutation.
  private providers: ProviderInfo[] = MOCK_PROVIDERS.map((p) => ({ ...p }));
  private defaults: ModelDefaults = {
    ...MOCK_MODEL_DEFAULTS,
    favorites: [...MOCK_MODEL_DEFAULTS.favorites],
  };

  subscribe(listener: (ev: SessionDriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTrust(listener: (ev: TrustEvent) => void): () => void {
    this.trustListeners.add(listener);
    return () => this.trustListeners.delete(listener);
  }

  private emit(ev: SessionDriverEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[mock] listener error", e);
      }
    }
  }

  private emitTrust(ev: TrustEvent): void {
    for (const l of this.trustListeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[mock] trust listener error", e);
      }
    }
  }

  respondTrust(requestId: string, choice: number | null): void {
    if (!this.pendingTrust.has(requestId)) return; // first-responder-wins / unknown
    this.pendingTrust.delete(requestId);
    this.emitTrust({ kind: "resolved", requestId });
    // Echo the outcome as a notice, mirroring respondUi's confirmation UX.
    const message =
      choice === null
        ? "Trust prompt dismissed — folder left untrusted."
        : `Trust decision recorded (option ${choice + 1}).`;
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiRequest",
      request: {
        kind: "notify",
        requestId: `trust-done-${requestId}`,
        message,
        level: "info",
      },
    });
  }

  /** Schedule a script's steps with their cumulative delays. */
  private play(steps: ScriptStep[]): void {
    let t = 0;
    for (const step of steps) {
      t += step.wait;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.emit(step.event);
        if (
          step.event.type === "hostUiRequest" &&
          "timeoutMs" in step.event.request
        ) {
          // remember dialogs so respondUi / abort can settle them
          this.pendingDialogs.add(step.event.request.requestId);
        }
      }, t);
      this.timers.add(timer);
    }
  }

  /** Emit the initial conversation so a fresh server isn't blank. */
  bootstrap(): void {
    this.play(greeting());
  }

  /** Cancel everything in flight and replay the initial fixture (test determinism). */
  reset(): void {
    this.cancelTimers();
    this.sessions = SESSION_LIST.map((s) => ({ ...s }));
    this.config = { ...MOCK_DEFAULT_CONFIG };
    this.providers = MOCK_PROVIDERS.map((p) => ({ ...p }));
    this.defaults = {
      ...MOCK_MODEL_DEFAULTS,
      favorites: [...MOCK_MODEL_DEFAULTS.favorites],
    };
    this.bootstrap();
  }

  prompt(text: string): void {
    this.play(promptReply(text));
  }

  abort(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "runCompleted",
      snapshot: {
        ref: SESSION_REF,
        workspace: {
          workspaceId: SESSION_REF.workspaceId,
          path: "/Users/timo/src/pilot",
        },
        title: "Wire up the WebSocket bridge",
        status: "idle",
        updatedAt: String(Date.now()),
      },
    });
  }

  respondUi(response: HostUiResponse): void {
    this.pendingDialogs.delete(response.requestId);
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiResolved",
      requestId: response.requestId,
    });
    const summary =
      "cancelled" in response
        ? "Dialog cancelled."
        : "confirmed" in response
          ? response.confirmed
            ? "Approved — continuing."
            : "Denied — skipping that step."
          : `Received: ${response.value}`;
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiRequest",
      request: {
        kind: "notify",
        requestId: `resolved-${response.requestId}`,
        message: summary,
        level: "info",
      },
    });
  }

  async listSessions(): Promise<SessionListEntry[]> {
    return this.sessions.map((s) => ({ ...s }));
  }

  async openSession(path: string): Promise<SessionDriverEvent[]> {
    this.cancelTimers(); // a switch ends any in-flight stream
    return mockSessionSeed(path);
  }

  async newSession(
    cwd?: string,
    worktree?: boolean,
  ): Promise<SessionDriverEvent[]> {
    this.cancelTimers();
    // Honor a typed cwd so the new row groups under that project in the sidebar
    // (deterministic: one synthetic "new" entry per distinct cwd). A worktree request
    // is simulated as a sibling "-worktree" dir so the isolated path is visible in e2e.
    const base = cwd?.trim() || NEW_SESSION_ENTRY.cwd;
    const dir = worktree ? `${base.replace(/\/+$/, "")}-worktree` : base;
    const sessionId =
      dir === NEW_SESSION_ENTRY.cwd
        ? NEW_SESSION_ENTRY.sessionId
        : `new-${dir}`;
    if (!this.sessions.some((s) => s.sessionId === sessionId))
      this.sessions = [
        { ...NEW_SESSION_ENTRY, sessionId, cwd: dir },
        ...this.sessions,
      ];
    return newSessionSeed();
  }

  async listModels(): Promise<ModelOption[]> {
    return MOCK_MODELS.map((m) => ({ ...m }));
  }

  async listCommands(): Promise<CommandInfo[]> {
    return MOCK_COMMANDS.map((c) => ({ ...c }));
  }

  setModel(provider: string, modelId: string): void {
    this.config = { ...this.config, provider, modelId };
    this.emitConfig();
  }

  setThinking(level: string): void {
    this.config = { ...this.config, thinkingLevel: level };
    this.emitConfig();
  }

  async listProviders(): Promise<ProviderInfo[]> {
    return this.providers.map((p) => ({ ...p }));
  }

  async setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new Error("API key is required");
    const p = this.providers.find((x) => x.id === providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    if (!p.apiKeySetupSupported)
      throw new Error(`API key setup isn't supported for ${providerId}`);
    this.providers = this.providers.map((x) =>
      x.id === providerId
        ? { ...x, hasAuth: true, authSource: "auth_file" }
        : x,
    );
  }

  async removeProviderApiKey(providerId: string): Promise<void> {
    this.providers = this.providers.map((x) =>
      x.id === providerId ? { ...x, hasAuth: false, authSource: "none" } : x,
    );
  }

  async getModelDefaults(): Promise<ModelDefaults> {
    return { ...this.defaults, favorites: [...this.defaults.favorites] };
  }

  async setDefaultModel(provider: string, modelId: string): Promise<void> {
    this.defaults = { ...this.defaults, provider, modelId };
  }

  async setDefaultThinking(level: string): Promise<void> {
    this.defaults = { ...this.defaults, thinkingLevel: level };
  }

  async setFavoriteModels(refs: readonly string[]): Promise<void> {
    this.defaults = { ...this.defaults, favorites: [...refs] };
  }

  /** Broadcast the current model selection as a sessionUpdated (idle) snapshot. */
  private emitConfig(): void {
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "sessionUpdated",
      snapshot: snapshot({ config: this.config }),
    });
  }

  private cancelTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingDialogs.clear();
    this.pendingTrust.clear();
  }

  runScript(name: string): void {
    if (name === "trust") {
      // The trust card rides the out-of-band trust channel, not the event stream.
      const req = mockTrustRequest();
      this.pendingTrust.add(req.requestId);
      this.emitTrust({ kind: "request", request: req });
      return;
    }
    const map: Record<string, () => ScriptStep[]> = {
      confirm: confirmDialog,
      input: inputDialog,
      ambient,
      bgrun: bgRun,
      reply: () => promptReply("Show me the streamed reply script."),
      editdiff: editDiff,
      error: errorRun,
      idle: idleNoComplete,
      streamhold: streamHold,
      timeout: timeoutConfirm,
      yesno: yesNoSelect,
    };
    const make = map[name];
    if (make) this.play(make());
  }
}

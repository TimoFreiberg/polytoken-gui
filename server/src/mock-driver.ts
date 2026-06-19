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
  SessionUsage,
} from "@pilot/protocol";
import type {
  NewSessionOpts,
  OAuthLoginIO,
  PilotDriver,
  TrustEvent,
} from "./driver.js";
import {
  ambient,
  bgRun,
  confirmDialog,
  editDiff,
  errorRun,
  greeting,
  idleNoComplete,
  initializingSession,
  inputDialog,
  markdownShowcase,
  staleIdle,
  MOCK_COMMANDS,
  MOCK_DEFAULT_CONFIG,
  MOCK_MODEL_DEFAULTS,
  MOCK_MODELS,
  MOCK_PROVIDERS,
  MOCK_USAGE,
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

/** Build the mock's worktree index from the fixture list: any SESSION_LIST entry
 *  whose `worktree` is set seeds the map keyed by the session's cwd (== the worktree
 *  dir), carrying its `base`/`name`. Mirrors the real WorktreeStore loading from disk —
 *  the listSessions overlay then reads from this map rather than the fixture's
 *  `worktree` field directly, so cleanup/archive and newSession stay consistent. */
function seedWorktrees(
  sessions: readonly SessionListEntry[],
): Map<string, { base: string; name: string }> {
  const m = new Map<string, { base: string; name: string }>();
  for (const s of sessions) {
    if (s.worktree)
      m.set(s.cwd, { base: s.worktree.base, name: s.worktree.name });
  }
  return m;
}

export class MockDriver implements PilotDriver {
  private listeners = new Set<(ev: SessionDriverEvent) => void>();
  private trustListeners = new Set<(ev: TrustEvent) => void>();
  private pendingTrust = new Set<string>();
  // In-flight scripted steps, in chronological order. We keep the step alongside its
  // timer (not just the raw handle) so a NEW script can flush the in-flight one to
  // completion before it starts — see play() for why interleaving corrupts state.
  private scheduled: Array<{
    timer: ReturnType<typeof setTimeout>;
    step: ScriptStep;
  }> = [];
  private pendingDialogs = new Set<string>();
  // Tool callIds that have started but not yet finished. Tracked so abort() can settle
  // them (emit a toolFinished), mirroring real pi's tool_execution_end on abort —
  // otherwise an aborted turn leaves a tool card "running" forever.
  private openTools = new Set<string>();
  private sessions: SessionListEntry[] = SESSION_LIST.map((s) => ({ ...s }));
  // Worktrees the mock "created" (the -worktree sibling dirs), keyed by the worktree
  // cwd (== the session's cwd) → {base, name}. Mirrors the real WorktreeStore so
  // listSessions flags worktree-backed rows with their parent project for grouping,
  // and cleanup/archive only ever touch mock worktrees. Seeded from SESSION_LIST at
  // construction + reset (mirroring how the real WorktreeStore loads its index from
  // disk) so any fixture worktree session carries its base/name into the overlay.
  // Mock worktrees are always clean.
  private worktrees = seedWorktrees(SESSION_LIST);
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
  // Live context-window fill, grown a step on each poll so the meter is visibly
  // non-static during a run (the hub polls getUsage ~1s while a turn streams). Reset()
  // restores the baseline. MOCK_USAGE.tokens is a concrete number (its type allows null
  // for the post-compaction case, which the mock baseline never is) — fall back to 0.
  private liveUsageTokens = MOCK_USAGE.tokens ?? 0;
  // Transient per-session overlay on userMessageCount: bumped each getUsage poll so the
  // focused running row's count visibly climbs mid-turn (live-updates.e2e), and cleared
  // on runCompleted so an idle row shows its true operator-turn count (sidebar-context.e2e).
  // An overlay — not a mutation of the fixture count — so idle and reset() restore baseline.
  private liveCountBumps = new Map<string, number>();

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
    // Serialize replays: instantly settle any in-flight script before starting a new
    // one. Two concurrent timer sequences interleave their assistantDelta events, and
    // foldEvent appends each delta to whichever assistant is currently open — so an
    // overlapping greeting + reply splits one thinking block across two turns and
    // leaks the greeting's tail text into the reply. Flushing keeps the mock's
    // one-turn-at-a-time semantics, matching real pi. (Tests drive a new script the
    // moment the greeting's first line is visible, well before it finishes streaming.)
    this.flushScheduled();
    let t = 0;
    for (const step of steps) {
      t += step.wait;
      const entry: { timer: ReturnType<typeof setTimeout>; step: ScriptStep } =
        {
          timer: setTimeout(() => {
            const i = this.scheduled.indexOf(entry);
            if (i >= 0) this.scheduled.splice(i, 1);
            this.fireStep(step);
          }, t),
          step,
        };
      this.scheduled.push(entry);
    }
  }

  /** Emit one step's event plus its side bookkeeping. Shared by the timer path and
   *  flushScheduled so a flushed event behaves exactly like a fired one. */
  private fireStep(step: ScriptStep): void {
    // A turn ending settles the live message-count overlay back to the fixture
    // baseline before the hub's run-end list broadcast reads it (see getUsage).
    if (step.event.type === "runCompleted") this.liveCountBumps.clear();
    // Track in-flight tools so abort() can settle whatever a turn left running.
    if (step.event.type === "toolStarted")
      this.openTools.add(step.event.callId);
    else if (step.event.type === "toolFinished")
      this.openTools.delete(step.event.callId);
    this.emit(step.event);
    if (
      step.event.type === "hostUiRequest" &&
      "timeoutMs" in step.event.request
    ) {
      // remember dialogs so respondUi / abort can settle them
      this.pendingDialogs.add(step.event.request.requestId);
    }
  }

  /** Fire every still-pending step immediately, in order, cancelling its timer.
   *  Settles an in-flight replay before a new one begins so the two never interleave. */
  private flushScheduled(): void {
    const entries = this.scheduled;
    this.scheduled = [];
    for (const entry of entries) {
      clearTimeout(entry.timer);
      this.fireStep(entry.step);
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
    this.liveCountBumps.clear();
    this.worktrees = seedWorktrees(SESSION_LIST);
    this.config = { ...MOCK_DEFAULT_CONFIG };
    this.providers = MOCK_PROVIDERS.map((p) => ({ ...p }));
    this.defaults = {
      ...MOCK_MODEL_DEFAULTS,
      favorites: [...MOCK_MODEL_DEFAULTS.favorites],
    };
    this.liveUsageTokens = MOCK_USAGE.tokens ?? 0;
    this.bootstrap();
  }

  prompt(
    text: string,
    _deliverAs?: "steer" | "followUp",
    _sessionId?: string,
    _images?: readonly import("@pilot/protocol").ImageContent[],
  ): void {
    this.play(promptReply(text));
  }

  abort(): void {
    for (const entry of this.scheduled) clearTimeout(entry.timer);
    this.scheduled = [];
    // Settle any tool the aborted turn left running, mirroring real pi (which emits a
    // tool_execution_end on abort). Without this the tool card stays "running" and the
    // robust turnActive signal would keep the stop affordance up after the turn ended.
    for (const callId of this.openTools)
      this.emit({
        sessionRef: SESSION_REF,
        timestamp: String(Date.now()),
        type: "toolFinished",
        callId,
        success: false,
        output: "Aborted.",
      });
    this.openTools.clear();
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
    return this.sessions.map((s) => ({
      ...s,
      userMessageCount:
        s.userMessageCount + (this.liveCountBumps.get(s.sessionId) ?? 0),
      worktree: (() => {
        const meta = this.worktrees.get(s.cwd);
        return meta
          ? { path: s.cwd, base: meta.base, name: meta.name }
          : undefined;
      })(),
    }));
  }

  getUsage(sessionId?: string): SessionUsage {
    // Climb the live context meter each poll so it's visibly non-static during a run (the
    // hub polls this ~1s for the focused, running session). Also grow a TRANSIENT overlay
    // on the focused row's message count so it climbs mid-turn (live-updates.e2e):
    // listSessions adds it on top of the fixture count, and a turn ending clears it (see
    // play) so an idle row shows its true operator-turn count (sidebar-context.e2e).
    this.liveUsageTokens = Math.min(
      this.liveUsageTokens + 2800,
      MOCK_USAGE.contextWindow,
    );
    if (sessionId)
      this.liveCountBumps.set(
        sessionId,
        (this.liveCountBumps.get(sessionId) ?? 0) + 1,
      );
    return {
      tokens: this.liveUsageTokens,
      contextWindow: MOCK_USAGE.contextWindow,
      percent:
        Math.round((this.liveUsageTokens / MOCK_USAGE.contextWindow) * 1000) /
        10,
    };
  }

  async setArchived(path: string, archived: boolean): Promise<void> {
    this.sessions = this.sessions.map((s) =>
      s.path === path ? { ...s, archived } : s,
    );
    // Archiving a worktree session reaps the (always-clean) mock worktree, mirroring the
    // real driver's safe cleanup so the indicator clears.
    if (archived) {
      const cwd = this.sessions.find((s) => s.path === path)?.cwd;
      if (cwd) this.worktrees.delete(cwd);
    }
  }

  async cleanupWorktree(
    path: string,
  ): Promise<{ removed: boolean; reason?: string }> {
    // Mock worktrees are always clean, so force is moot — just forget it.
    if (!this.worktrees.has(path))
      return { removed: false, reason: "no pilot worktree at this path" };
    this.worktrees.delete(path);
    return { removed: true };
  }

  async renameSession(path: string, name: string): Promise<void> {
    const next = name.trim();
    if (!next) return;
    this.sessions = this.sessions.map((s) =>
      s.path === path ? { ...s, displayName: next } : s,
    );
  }

  async openSession(path: string): Promise<SessionDriverEvent[]> {
    this.cancelTimers(); // a switch ends any in-flight stream
    return mockSessionSeed(path);
  }

  async newSession(opts: NewSessionOpts = {}): Promise<SessionDriverEvent[]> {
    this.cancelTimers();
    const { cwd, worktree, model, thinking } = opts;
    // Honor a typed cwd so the new row groups under that project in the sidebar
    // (deterministic: one synthetic "new" entry per distinct cwd). A worktree request
    // is simulated as a sibling "-worktree" dir so the isolated path is visible in e2e.
    const base = cwd?.trim() || NEW_SESSION_ENTRY.cwd;
    const dir = worktree ? `${base.replace(/\/+$/, "")}-worktree` : base;
    if (worktree) this.worktrees.set(dir, { base, name: `pilot-mock-${dir}` });
    const sessionId =
      dir === NEW_SESSION_ENTRY.cwd
        ? NEW_SESSION_ENTRY.sessionId
        : `new-${dir}`;
    if (!this.sessions.some((s) => s.sessionId === sessionId))
      this.sessions = [
        { ...NEW_SESSION_ENTRY, sessionId, cwd: dir },
        ...this.sessions,
      ];
    // Carry the draft's model/thinking into the new session's config so the picker
    // reflects them immediately (mirrors the real driver applying them at creation).
    const chosen = model
      ? MOCK_MODELS.find(
          (m) => m.provider === model.provider && m.modelId === model.modelId,
        )
      : undefined;
    this.config = {
      provider: model?.provider ?? MOCK_DEFAULT_CONFIG.provider,
      modelId: model?.modelId ?? MOCK_DEFAULT_CONFIG.modelId,
      thinkingLevel: thinking ?? MOCK_DEFAULT_CONFIG.thinkingLevel,
      availableThinkingLevels:
        chosen?.thinkingLevels ?? MOCK_DEFAULT_CONFIG.availableThinkingLevels,
    };
    return newSessionSeed({ cwd: dir, config: this.config });
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

  /** Simulate the remote browser OAuth flow deterministically: announce, hand back a
   *  fake authorize URL + paste field, accept any non-empty answer, mark connected.
   *  A cancelled prompt (null) aborts like the real flow. */
  async oauthLogin(providerId: string, io: OAuthLoginIO): Promise<void> {
    const p = this.providers.find((x) => x.id === providerId);
    if (!p) throw new Error(`unknown provider ${providerId}`);
    if (!p.oauthSupported)
      throw new Error(`OAuth login isn't supported for ${providerId}`);
    io.progress(`Opening ${p.name} authorization…`);
    const answer = await io.prompt({
      kind: "input",
      message: "Paste the authorization code or the full redirect URL",
      placeholder: "code, or http://localhost/callback?code=…",
      url: `https://example.com/oauth/authorize?mock=${providerId}`,
      instructions:
        "(mock) Open the link, then paste anything back to complete sign-in.",
    });
    if (answer == null) throw new Error("OAuth login cancelled");
    io.progress("Exchanging authorization code for tokens…");
    this.providers = this.providers.map((x) =>
      x.id === providerId ? { ...x, hasAuth: true, authSource: "oauth" } : x,
    );
  }

  async oauthLogout(providerId: string): Promise<void> {
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
    for (const entry of this.scheduled) clearTimeout(entry.timer);
    this.scheduled = [];
    this.pendingDialogs.clear();
    this.pendingTrust.clear();
    this.openTools.clear();
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
      initializing: initializingSession,
      markdown: markdownShowcase,
      staleidle: staleIdle,
      streamhold: streamHold,
      timeout: timeoutConfirm,
      yesno: yesNoSelect,
    };
    const make = map[name];
    if (make) this.play(make());
  }
}

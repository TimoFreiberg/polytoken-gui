// Replays deterministic fixture scripts as a PilotDriver. Stands in for a real pi
// session so the whole UI pipeline can be built and screenshot-verified without a
// live model or API keys.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isDialogRequest,
  PILOT_OWNED_EXTENSION_NAMES,
  isPilotOwnedExtension,
  type CommandInfo,
  type DirListing,
  type ExtensionInfo,
  type PathStat,
  type FileInfo,
  type HostUiRequest,
  type HostUiResponse,
  type ModelDefaults,
  type ModelOption,
  type ProviderInfo,
  type QnaAnswer,
  type QnaQuestion,
  type SessionConfig,
  type SessionDriverEvent,
  type SessionListEntry,
  type SessionSnapshot,
  type SessionQueuedMessage,
  type SessionUsage,
  type TreeSnapshot,
} from "@pilot/protocol";
import type { NewSessionOpts, OAuthLoginIO, PilotDriver, TrustEvent } from "./driver.js";
import { writePilotSettings, readPilotSettings } from "./settings-store.js";
import {
  ambient,
  answerCard,
  answerLeadUpCard,
  bgRun,
  bgWait,
  branchedSeed,
  compat,
  confirmDialog,
  editDiff,
  errorRun,
  GREETING_PROMPT,
  greeting,
  contextFull,
  idleNoComplete,
  imageReply,
  initializingSession,
  inputDialog,
  journalNudge,
  longOutput,
  markdownShowcase,
  mockTree,
  qnaDialog,
  planHandoff,
  planFacet,
  selectMany,
  staleIdle,
  MOCK_COMMANDS,
  MOCK_EXTENSIONS,
  MOCK_FILES,
  MOCK_DEFAULT_CONFIG,
  MOCK_MODEL_DEFAULTS,
  MOCK_MODELS,
  MOCK_PROVIDERS,
  MOCK_BACKGROUND_MODEL,
  MOCK_USAGE,
  mockSessionSeed,
  mockTrustRequest,
  NEW_SESSION_ENTRY,
  newSessionReply,
  newSessionSeed,
  pendingHold,
  promptReply,
  searchBatch,
  skillLoad,
  thinkingBetweenTools,
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

/** Render a submitted Q&A into the same transcript text the answer extension's
 *  `formatQnA` produces (Q / context / Options / A lines), so the mock exercises the
 *  client's parse-and-render path. Kept in sync with agents/extensions/answer.ts. */
function formatQnaText(
  questions: readonly QnaQuestion[],
  answers: readonly QnaAnswer[],
): string {
  const parts: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const a = answers[i] ?? { selectedOptionIndices: [], customText: "" };
    parts.push(`Q: ${q.question}`);
    if (q.context) parts.push(`> ${q.context}`);
    const opts = q.options ?? [];
    const hasOptions = opts.length > 0;
    if (hasOptions) {
      const picked = new Set(a.selectedOptionIndices);
      parts.push("Options:");
      for (let j = 0; j < opts.length; j++) {
        parts.push(`  ${picked.has(j) ? "[x]" : "[ ]"} ${opts[j]!.label}`);
      }
    }
    const chosen = hasOptions
      ? a.selectedOptionIndices
          .filter((idx) => idx >= 0 && idx < opts.length)
          .map((idx) => opts[idx]!.label)
      : [];
    const custom = a.customText.trim();
    const segments = [...chosen];
    if (custom) segments.push(hasOptions ? `(typed) ${custom}` : custom);
    parts.push(
      `A: ${segments.length > 0 ? segments.join(", ") : "(no answer)"}`,
    );
    parts.push("");
  }
  return parts.join("\n").trim();
}

/** Child layout (relative to a root) for the mock's synthetic directory tree. "" is the
 *  root itself. */
const MOCK_DIR_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  "": ["src", "Documents", "Downloads", "Projects", ".config"],
  // `demo` / `elsewhere` are empty project dirs the e2e suite navigates into to start a
  // session (incl. worktree creation) somewhere other than the seeded sessions' cwds.
  src: [
    "pilot",
    "pi",
    "pi-gui",
    "kellercomm",
    "scratch",
    "demo",
    "elsewhere",
    // A worktree created under `dirty` is treated as having uncommitted changes, so
    // archiving keeps it — exercises the "worktree kept" toast path deterministically.
    "dirty",
  ],
  "src/pilot": ["client", "server", "protocol", "e2e", "docs"],
  "src/pi": ["src", "docs", "examples"],
  Documents: ["notes", "receipts"],
  Projects: ["website"],
  ".config": ["pi", "fish"],
};

/** A small synthetic directory tree for the new-session picker, instantiated under two
 *  roots so the picker has content for both the paths the mock hands out: the real $HOME
 *  (the hub's `defaultNewSessionCwd` + the "home" shortcut) and `/Users/timo` (the prefix
 *  the fixture sessions' cwds hardcode — see fixtures.ts). On a dev mac these coincide; on
 *  CI ($HOME differs) keying both keeps the preview + e2e deterministic without touching
 *  the real disk. Child names are stable regardless of the actual home path. */
const MOCK_DIR_TREE: ReadonlyMap<string, readonly string[]> = (() => {
  const roots = [...new Set([homedir(), "/Users/timo"])];
  const tree = new Map<string, readonly string[]>();
  for (const root of roots) {
    for (const [rel, kids] of Object.entries(MOCK_DIR_LAYOUT)) {
      tree.set(rel ? join(root, rel) : root, kids);
    }
  }
  return tree;
})();

export class MockDriver implements PilotDriver {
  private listeners = new Set<(ev: SessionDriverEvent) => void>();
  private trustListeners = new Set<(ev: TrustEvent) => void>();
  private pendingTrust = new Set<string>();
  // One-shot: when set, the next newSession() rejects then clears (armed via
  // runScript("failnewsession")). Simulates a transient creation failure for e2e.
  private failNextNewSession = false;
  // The most recently created session's id + seed snapshot, so the FIRST prompt that
  // follows (the deferred-creation first turn) streams under that session's own ref
  // instead of the demo session's. Consumed (cleared) by that first prompt. Without this
  // the new session's first turn would fold into the demo session and never reach the
  // focused new-session transcript.
  private lastCreated: { sessionId: string; snapshot: SessionSnapshot } | null =
    null;
  // In-flight scripted steps, in chronological order. We keep the step alongside its
  // timer (not just the raw handle) so a NEW script can flush the in-flight one to
  // completion before it starts — see play() for why interleaving corrupts state.
  private scheduled: Array<{
    timer: ReturnType<typeof setTimeout>;
    step: ScriptStep;
  }> = [];
  private pendingDialogs = new Map<
    string,
    { request: HostUiRequest; sessionRef: SessionDriverEvent["sessionRef"] }
  >();
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
  // Mock worktrees are always clean, EXCEPT ones created under a `dirty` project (see
  // MOCK_DIR_LAYOUT) — those land in this set so archive keeps them and exercises the
  // "worktree kept" toast.
  private worktrees = seedWorktrees(SESSION_LIST);
  private dirtyWorktrees = new Set<string>();
  // cwds whose worktree dir has been reaped (cleaned up / archived). Mirrors the real
  // WorktreeStore tombstone: the meta stays in `worktrees` so the orphaned session keeps
  // grouping under its parent project, but the live affordances + ownership gate drop it.
  private reapedWorktrees = new Set<string>();
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
  // Extensions for the Settings "Extensions" view; `enabled` is toggled in-memory and
  // restored to the fixture baseline by reset() (mirrors how providers/defaults work).
  private extensions: ExtensionInfo[] = MOCK_EXTENSIONS.map((e) => ({ ...e }));
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
  private queues = new Map<string, SessionQueuedMessage[]>();
  // Whether the bootstrap greeting is the landing session. The hub reads it via
  // defaultSeed() to give a freshly-connecting client the demo transcript without a
  // live replay (per-client focus: each connection adopts the default on its own).
  private bootstrapped = false;

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

  private emitQueue(sessionId: string): void {
    const sessionRef =
      sessionId === SESSION_REF.sessionId
        ? SESSION_REF
        : { workspaceId: SESSION_REF.workspaceId, sessionId };
    this.emit({
      sessionRef,
      timestamp: String(Date.now()),
      type: "queueUpdated",
      messages: this.queues.get(sessionId) ?? [],
    });
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
      isDialogRequest(step.event.request)
    )
      this.pendingDialogs.set(step.event.request.requestId, {
        request: step.event.request,
        sessionRef: step.event.sessionRef,
      });
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

  /** Make the greeting the landing session so a fresh server isn't blank. The
   *  transcript is delivered via defaultSeed() (folded once per connecting client),
   *  not a live replay — so two clients can adopt it independently without racing or
   *  double-folding a streaming greeting. */
  bootstrap(): void {
    this.bootstrapped = true;
    // Seed a sample background-model spec so the dev preview's Settings "Models" section
    // shows a populated, cleanly-resolving control on first load. The e2e's `/debug/reset`
    // (hub.reset) wipes pilot-settings back to defaults before each test, so this seed
    // only affects the eyeball-the-preview path, not the deterministic e2e baseline.
    writePilotSettings({ backgroundModel: MOCK_BACKGROUND_MODEL });
  }

  /** The landing session's seed (the greeting) when bootstrapped, else null (the
   *  empty production landing). Same events as openSession(demo) / a live greeting, so
   *  folding it yields the identical transcript. */
  defaultSeed(): SessionDriverEvent[] | null {
    return this.bootstrapped
      ? mockSessionSeed("/sessions/demo-session.jsonl")
      : null;
  }

  /** Cancel everything in flight and optionally replay the initial fixture. Skipping
   *  bootstrap exposes the real driver's empty startup landing for focused e2e tests. */
  reset(opts: { bootstrap?: boolean } = {}): void {
    this.cancelTimers();
    this.queues.clear();
    this.sessions = SESSION_LIST.map((s) => ({ ...s }));
    this.liveCountBumps.clear();
    this.failNextNewSession = false;
    this.worktrees = seedWorktrees(SESSION_LIST);
    this.dirtyWorktrees = new Set<string>();
    this.reapedWorktrees = new Set<string>();
    this.config = { ...MOCK_DEFAULT_CONFIG };
    this.providers = MOCK_PROVIDERS.map((p) => ({ ...p }));
    this.defaults = {
      ...MOCK_MODEL_DEFAULTS,
      favorites: [...MOCK_MODEL_DEFAULTS.favorites],
    };
    this.extensions = MOCK_EXTENSIONS.map((e) => ({ ...e }));
    this.liveUsageTokens = MOCK_USAGE.tokens ?? 0;
    this.bootstrapped = opts.bootstrap !== false;
  }

  prompt(
    text: string,
    _deliverAs?: "steer" | "followUp",
    sessionId?: string,
    images?: readonly import("@pilot/protocol").ImageContent[],
    promptId?: string,
  ): Promise<void> {
    if (text === "__pilot_reject_prompt__")
      return Promise.reject(
        new Error("Mock prompt rejected before acceptance"),
      );
    // Deferred-creation first turn: this prompt targets the session we JUST created, so
    // stream it under that session's own ref (not the demo session's) and consume the
    // one-shot marker. Subsequent prompts fall through to the normal demo-session reply.
    if (
      sessionId &&
      this.lastCreated &&
      sessionId === this.lastCreated.sessionId
    ) {
      const { snapshot } = this.lastCreated;
      this.lastCreated = null;
      this.play(
        newSessionReply(snapshot, text, promptId ?? `u-${Date.now()}`, images),
      );
      return Promise.resolve();
    }
    this.play(promptReply(text, promptId, images));
    return Promise.resolve();
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

  clearQueue(sessionId = SESSION_REF.sessionId): {
    steering: string[];
    followUp: string[];
  } {
    const queued = this.queues.get(sessionId) ?? [];
    this.queues.set(sessionId, []);
    this.emitQueue(sessionId);
    return {
      steering: queued
        .filter((message) => message.mode === "steer")
        .map((message) => message.text),
      followUp: queued
        .filter((message) => message.mode === "followUp")
        .map((message) => message.text),
    };
  }

  respondUi(response: HostUiResponse): void {
    const pending = this.pendingDialogs.get(response.requestId);
    this.pendingDialogs.delete(response.requestId);
    const sessionRef = pending?.sessionRef ?? SESSION_REF;
    this.emit({
      sessionRef,
      timestamp: String(Date.now()),
      type: "hostUiResolved",
      requestId: response.requestId,
    });

    // Q&A submissions: mirror real pi, where the `answer` tool records the filled-in
    // Q&A as its result. The client surfaces that as a visible transcript block, so
    // emit a real toolStarted/toolFinished pair (not a notify) to exercise that path.
    if ("answers" in response) {
      const req = pending?.request;
      const questions = req?.kind === "qna" ? req.questions : [];
      const text = formatQnaText(questions, response.answers);
      const callId = `answer-${response.requestId}`;
      this.emit({
        sessionRef,
        timestamp: String(Date.now()),
        type: "toolStarted",
        callId,
        toolName: "answer",
        label: "Answer",
        input: { questions },
      });
      this.emit({
        sessionRef,
        timestamp: String(Date.now()),
        type: "toolFinished",
        callId,
        success: true,
        output: { content: [{ type: "text", text }] },
      });
      return;
    }

    const summary =
      "cancelled" in response
        ? "Dialog cancelled."
        : "confirmed" in response
          ? response.confirmed
            ? "Approved — continuing."
            : "Denied — skipping that step."
          : `Received: ${response.value}`;
    this.emit({
      sessionRef,
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
          ? {
              path: s.cwd,
              base: meta.base,
              name: meta.name,
              reaped: this.reapedWorktrees.has(s.cwd) || undefined,
            }
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

  async setArchived(
    path: string,
    archived: boolean,
  ): Promise<{ worktreeRetained?: { path: string; reason: string } } | void> {
    this.sessions = this.sessions.map((s) =>
      s.path === path ? { ...s, archived } : s,
    );
    // Archiving a worktree session reaps the (clean) mock worktree, mirroring the real
    // driver's safe cleanup so the indicator clears. A dirty one is kept and reported
    // back, exactly as the real driver does, so the client can explain the leftover.
    if (archived) {
      const cwd = this.sessions.find((s) => s.path === path)?.cwd;
      if (cwd && this.worktrees.has(cwd) && !this.reapedWorktrees.has(cwd)) {
        if (this.dirtyWorktrees.has(cwd))
          return {
            worktreeRetained: { path: cwd, reason: "uncommitted changes" },
          };
        // Tombstone, don't delete: keep the meta so the session keeps grouping.
        this.reapedWorktrees.add(cwd);
      }
    }
  }

  async cleanupWorktree(
    path: string,
  ): Promise<{ removed: boolean; reason?: string }> {
    // Mock worktrees are always clean, so force is moot — just forget it. Tombstone
    // (mark reaped) rather than delete so the orphaned session keeps grouping under
    // its parent project, mirroring the real WorktreeStore.
    if (!this.worktrees.has(path) || this.reapedWorktrees.has(path))
      return { removed: false, reason: "no pilot worktree at this path" };
    this.reapedWorktrees.add(path);
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
    const seed = mockSessionSeed(path);
    const sessionId = seed[0]?.sessionRef.sessionId;
    const queued = sessionId ? (this.queues.get(sessionId) ?? []) : [];
    const withQueue = seed.map((event): SessionDriverEvent => {
      if (
        event.type !== "sessionOpened" &&
        event.type !== "sessionUpdated" &&
        event.type !== "runCompleted"
      )
        return event;
      return {
        ...event,
        snapshot: { ...event.snapshot, queuedMessages: queued },
      };
    });
    const pending = [...this.pendingDialogs.values()]
      .filter((p) => p.sessionRef.sessionId === sessionId)
      .map(
        (p): SessionDriverEvent => ({
          sessionRef: p.sessionRef,
          timestamp: String(Date.now()),
          type: "hostUiRequest",
          request: p.request,
        }),
      );
    return [...withQueue, ...pending];
  }

  /** Deterministic stand-in for the pi driver's dispose-and-re-warm. The mock has no
   *  warm AgentSession to throw away, so a reload is just a fresh seed of the same
   *  session \u2014 enough to exercise the hub's reseed path and the client wiring. */
  async reloadSession(path: string): Promise<SessionDriverEvent[]> {
    return this.openSession(path);
  }

  /** Deterministic stand-in for pi's navigateTree. Branching from a USER node rewinds to
   *  an empty branch and hands that prompt's text back to prefill the composer (the re-edit
   *  gesture, mirroring navigateTree on a user message); any other node re-seeds the
   *  greeting unchanged (a no-op continue-from-here jump). The user prompts come from the
   *  tree fixture so any tree-view selection of a user node behaves consistently. Real tree
   *  navigation lives in the pi driver. */
  async branchFrom(
    entryId: string,
    _opts: { summarize?: boolean },
  ): Promise<{
    seed: SessionDriverEvent[];
    editorText?: string;
    cancelled: boolean;
  }> {
    this.cancelTimers();
    const node = mockTree().nodes.find((n) => n.id === entryId);
    if (node?.kind === "user")
      return {
        seed: branchedSeed(),
        editorText: entryId === "e-u1" ? GREETING_PROMPT : node.preview,
        cancelled: false,
      };
    return { seed: greeting().map((s) => s.event), cancelled: false };
  }

  /** The mock's branch tree — a fixed multi-branch fixture so the /tree view can be built
   *  and screenshot-verified without a real pi session that's been navigated. */
  async getTree(): Promise<TreeSnapshot> {
    return mockTree();
  }

  async newSession(opts: NewSessionOpts = {}): Promise<SessionDriverEvent[]> {
    // One-shot failure injection (armed via runScript("failnewsession")): reject before any
    // state mutation, mirroring a real driver whose `jj workspace add` hits a stale working
    // copy. Lets e2e exercise the client's draft-restore-on-failure path deterministically.
    if (this.failNextNewSession) {
      this.failNextNewSession = false;
      throw new Error(
        "The working copy is stale (mock newSession failure for tests)",
      );
    }
    this.cancelTimers();
    const { cwd, worktree, model, thinking } = opts;
    // Honor a typed cwd so the new row groups under that project in the sidebar
    // (deterministic: one synthetic "new" entry per distinct cwd). A worktree request
    // is simulated as a sibling "-worktree" dir so the isolated path is visible in e2e.
    const base = cwd?.trim() || NEW_SESSION_ENTRY.cwd;
    const dir = worktree ? `${base.replace(/\/+$/, "")}-worktree` : base;
    if (worktree) {
      this.worktrees.set(dir, { base, name: `pilot-mock-${dir}` });
      if (/(^|\/)dirty$/.test(base)) this.dirtyWorktrees.add(dir);
    }
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
    const seed = newSessionSeed({ cwd: dir, config: this.config });
    // Remember the seed snapshot so the first prompt (delivered right after this swap)
    // streams its turn under the new session's own ref — see prompt().
    const opened = seed.find((e) => e.type === "sessionOpened");
    if (opened?.type === "sessionOpened")
      this.lastCreated = {
        sessionId: opened.snapshot.ref.sessionId,
        snapshot: opened.snapshot,
      };
    return seed;
  }

  async listModels(): Promise<ModelOption[]> {
    return MOCK_MODELS.map((m) => ({ ...m }));
  }

  async listCommands(): Promise<CommandInfo[]> {
    return MOCK_COMMANDS.map((c) => ({ ...c }));
  }

  async listExtensions(): Promise<ExtensionInfo[]> {
    // Mirror the real driver's projection: a pilot-OWNED row's `enabled` reflects pilot's
    //   `enabledExtensions` set (the [OPEN E] toggle — pi's force-exclude is a no-op on
    //   owned paths). null = all owned enabled; an array = the enabled subset by name.
    const enabledExtensions = readPilotSettings().enabledExtensions;
    return this.extensions.map((e) => {
      if (!isPilotOwnedExtension(e.name)) return { ...e };
      const name = e.name.replace(/\.ts$/, "");
      const on =
        enabledExtensions === null || enabledExtensions.includes(name);
      return { ...e, enabled: on };
    });
  }

  async setExtensionEnabled(
    resolvedPath: string,
    enabled: boolean,
  ): Promise<void> {
    // Pilot-OWNED rows route to pilot's `enabledExtensions` set (mirrors the real
    //   driver — pi's force-exclude override is a no-op on additionalExtensionPaths).
    //   The mock keys off the fixture row's name (basename without .ts), like the real
    //   driver's ownedExtensionBasename. null = all enabled; an array = the subset.
    const owned = this.extensions.find((e) => e.resolvedPath === resolvedPath);
    const ownedName =
      owned && isPilotOwnedExtension(owned.name)
        ? owned.name.replace(/\.ts$/, "")
        : undefined;
    if (ownedName) {
      const cur = readPilotSettings().enabledExtensions ?? [
        ...PILOT_OWNED_EXTENSION_NAMES,
      ];
      const next = enabled
        ? cur.includes(ownedName)
          ? cur
          : [...cur, ownedName]
        : cur.filter((n) => n !== ownedName);
      const allEnabled =
        next.length === PILOT_OWNED_EXTENSION_NAMES.length &&
        PILOT_OWNED_EXTENSION_NAMES.every((n) => next.includes(n));
      writePilotSettings({
        enabledExtensions: allEnabled ? null : next,
      });
      return;
    }
    // User/project extension: flip the in-memory flag (the mock doesn't persist pi
    // settings); the re-broadcast list reflects it (the row stays visible either way).
    this.extensions = this.extensions.map((e) =>
      e.resolvedPath === resolvedPath ? { ...e, enabled } : e,
    );
  }

  async listFileIndex(): Promise<{ files: FileInfo[]; truncated: boolean }> {
    // The fixture set is small, so the client always has the full index — for a real session
    // the per-query fallback never fires (truncated stays false). A new-session DRAFT still
    // uses the fallback (listFiles below), since the pushed index is the wrong session's cwd.
    return { files: MOCK_FILES.map((f) => ({ ...f })), truncated: false };
  }

  async listFiles(
    query: string,
    _sessionId?: string,
    cwd?: string,
  ): Promise<FileInfo[]> {
    // A new-session draft passes its target cwd. Surface it as a synthetic match so the
    // draft @-mention path (Composer → store → hub → driver) is verifiable end-to-end; the
    // real driver actually searches that dir. A real session passes no cwd, so it's absent.
    const pool = cwd
      ? [
          {
            path: `${cwd.replace(/\/+$/, "")}/DRAFT-CWD.md`,
            isDirectory: false,
          },
          ...MOCK_FILES,
        ]
      : MOCK_FILES;
    if (!query.trim()) return pool.map((f) => ({ ...f })).slice(0, 20);
    const q = query.toLowerCase();
    return pool
      .filter((f) => f.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.length - b.path.length)
      .map((f) => ({ ...f }))
      .slice(0, 20);
  }

  async listDir(path?: string): Promise<DirListing> {
    // Empty -> $HOME (the picker's default open). The fixture tree is keyed by absolute
    // path; unknown dirs come back empty (the mock never touches the real disk).
    const dir = path?.trim() ? resolve(path.trim()) : homedir();
    const parent = dirname(dir);
    const parentOrNull = parent === dir ? null : parent;
    const entries = MOCK_DIR_TREE.get(dir);
    return {
      path: dir,
      parent: parentOrNull,
      entries: entries ? [...entries] : [],
    };
  }

  async statPath(path: string): Promise<PathStat> {
    const abs = resolve(path.trim());
    const exists = MOCK_DIR_TREE.has(abs);
    return { path: abs, exists, isDir: exists };
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
    if (name === "failnewsession") {
      // Arm a one-shot newSession() rejection (consumed by the next creation attempt).
      this.failNextNewSession = true;
      return;
    }
    if (name === "trust") {
      // The trust card rides the out-of-band trust channel, not the event stream.
      const req = mockTrustRequest();
      this.pendingTrust.add(req.requestId);
      this.emitTrust({ kind: "request", request: req });
      return;
    }
    if (name === "queue") {
      this.queues.set(SESSION_REF.sessionId, [
        {
          id: "queue-steer-fixture",
          mode: "steer",
          text: "Please inspect the failing test first.",
          createdAt: "queue-1",
          updatedAt: "queue-1",
        },
        {
          id: "queue-followup-fixture",
          mode: "followUp",
          text: "Then summarize the fix and remaining risks.",
          createdAt: "queue-2",
          updatedAt: "queue-2",
        },
      ]);
      this.emitQueue(SESSION_REF.sessionId);
      return;
    }
    if (name === "deliverqueue") {
      const queued = this.queues.get(SESSION_REF.sessionId) ?? [];
      const [next, ...remaining] = queued;
      if (!next) return;
      this.queues.set(SESSION_REF.sessionId, remaining);
      this.emit({
        sessionRef: SESSION_REF,
        timestamp: String(Date.now()),
        type: "queuedMessageStarted",
        message: next,
      });
      this.emitQueue(SESSION_REF.sessionId);
      return;
    }
    const map: Record<string, () => ScriptStep[]> = {
      confirm: confirmDialog,
      contextfull: contextFull,
      input: inputDialog,
      qna: qnaDialog,
      selectmany: selectMany,
      planhandoff: planHandoff,
      planfacet: planFacet,
      ambient,
      compat,
      answercard: answerCard,
      answerleadup: answerLeadUpCard,
      bgrun: bgRun,
      bgwait: bgWait,
      reply: () => promptReply("Show me the streamed reply script."),
      editdiff: editDiff,
      images: imageReply,
      error: errorRun,
      idle: idleNoComplete,
      initializing: initializingSession,
      journalnudge: journalNudge,
      longoutput: longOutput,
      markdown: markdownShowcase,
      search: searchBatch,
      thinkingtools: thinkingBetweenTools,
      skill: skillLoad,
      staleidle: staleIdle,
      streamhold: streamHold,
      pendinghold: pendingHold,
      timeout: timeoutConfirm,
      yesno: yesNoSelect,
    };
    const make = map[name];
    if (make) this.play(make());
  }
}

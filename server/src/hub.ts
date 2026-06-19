// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

import { homedir } from "node:os";
import {
  type ClientMessage,
  foldEvent,
  initialSessionState,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionDriverEvent,
  type SessionId,
  type SessionState,
} from "@pilot/protocol";
import type { OAuthLoginIO, PilotDriver } from "./driver.js";

export type Send = (msg: ServerMessage) => void;

// How long an OAuth prompt waits for the operator before the login aborts itself. The
// browser hop + copy/paste is slow but human-paced; a few minutes is generous without
// leaving a zombie login (and its loopback server) pending forever if a phone is closed.
const OAUTH_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/** What the hub hands to a notifier (e.g. the Web Push sender) for notable events. */
export interface HubNotification {
  title: string;
  body: string;
  tag?: string;
}

export class SessionHub {
  // The FOCUSED session's folded state — what every client sees (D8: global focus).
  // Background sessions stream live inside the driver (kept warm); they reach the hub
  // only so a finished background turn can still notify a closed phone.
  private state: SessionState = initialSessionState();
  private focusedId: SessionId | null = null;
  // Session ids with a live turn right now — tracked across ALL sessions, not just
  // the focused one (a background turn never folds into `state`/broadcasts events,
  // but the client still needs its running/done indicator). Pushed as `sessionStatus`
  // when the set changes. In-memory only: a session on disk is never "running".
  private running = new Set<SessionId>();
  // Sessions surfaced as `initializing` — created/opened but not yet streaming (warming
  // up: model load, history replay, trust). Tracked + broadcast alongside `running` so a
  // background/just-created row shows a distinct "spinning up" indicator. A session is
  // never both running and initializing; entering either clears the other here.
  private initializing = new Set<SessionId>();
  private clients = new Set<Send>();
  private serverId = `pilot-${Math.floor(Date.now() / 1000)}`;
  // Whether any client has connected since startup. Gates push so replayed history
  // — the mock's bootstrap greeting, or the pi driver's on-load session replay
  // (both can end in runCompleted while clientCount is 0) — doesn't buzz a stored
  // subscription on every restart. This is also how replay is told apart from live
  // events (D13): cold-start seeds fold before anyone connects, and switchTo folds
  // its seed directly rather than through onEvent, so neither reaches maybeNotify.
  private everConnected = false;
  // True only during a session swap: ignore stray driver events while we reset and
  // re-fold the new session's seed, so a half-switched state is never broadcast.
  private switching = false;
  // Single-flight guard for switchTo. The trust card (D12) can keep a swap awaiting
  // human input for minutes; without this, a second open/new arriving meanwhile would
  // race two swaps over the one `switching` flag and the focused state.
  private switchInFlight = false;
  // Debounced live-refresh ticker. While a turn runs, the only events that fire are
  // deltas/tool/user — none carries fresh `usage` and none re-lists sessions, so the
  // composer's context meter AND the sidebar rows (message count / name / preview)
  // freeze at their last turn-boundary value. This ticker re-broadcasts both on a
  // cadence; it runs only while something is running AND a client is watching, and is
  // nulled when idle. (getContextUsage / listSessions are O(messages|files) — fine once
  // a second, never on the per-delta path.)
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  // Desktop auto-update (driven by scripts/desktop/update-watcher.ts via /update/state).
  // `updateSha` is the origin/main commit the watcher staged but deferred because a client
  // is connected; null = up to date. `applying` flips true when a client clicks the
  // sidebar card's "update now" — the watcher reads it back on its next poll and applies.
  private updateSha: string | null = null;
  private applying = false;
  // OAuth login (Settings panel) is a GLOBAL interactive flow — it writes pi's shared
  // auth.json, not a session — so it rides its own wire messages, not the session-scoped
  // Host UI channel. While a login runs, its prompts wait here keyed by requestId; an
  // `oauthRespond` resolves one (first-responder-wins across devices). Single-flight:
  // one login at a time keeps the pending map unambiguous (a single user, one browser).
  private oauthPending = new Map<string, (value: string | null) => void>();
  private oauthSeq = 0;
  private oauthInFlight = false;

  constructor(
    private driver: PilotDriver,
    // Called on run-done / approval-needed when NO client is connected, i.e. every
    // surface is backgrounded/closed — exactly when a Web Push should reach a pocket.
    private notify?: (n: HubNotification) => void,
    // Cadence (ms) for the live-refresh ticker above. Default 1s; the e2e suite sets a
    // shorter value (PILOT_LIVE_REFRESH_MS) so the meter/list visibly climb in a test.
    private liveRefreshMs = 1000,
  ) {
    driver.subscribe((ev) => this.onEvent(ev));
    // Project-trust cards travel their own channel (D12): they're decided before a
    // session exists and while `switching` suppresses session events, so they can't go
    // through onEvent. Relay request → broadcast card, resolved → dismiss it.
    driver.subscribeTrust?.((ev) => {
      if (ev.kind === "request")
        this.broadcast({ type: "trustRequest", ...ev.request });
      else this.broadcast({ type: "trustResolved", requestId: ev.requestId });
    });
  }

  private onEvent(ev: SessionDriverEvent): void {
    const sid = ev.sessionRef.sessionId;
    // Track the running set across every session — including mid-swap and for
    // background sessions whose events are never broadcast. A session's turn/terminal
    // events are authoritative about whether it's running regardless of focus or an
    // in-flight switch. In particular, LRU eviction (pi-driver) disposes a warm session
    // *inside* a swap and emits a synthetic sessionClosed for it; that must clear the
    // running set here or the evicted session shows a perpetual running indicator. The
    // `switching` guard below only protects the focused-transcript fold + broadcast,
    // which the swap re-seeds — it must not gate cross-session running tracking.
    this.trackRunning(sid, ev);
    if (this.switching) return; // the swap orchestrates its own reset + re-fold
    // The first session to surface becomes the focus (e.g. the resumed session at
    // startup). Only the focused session folds into `state` and broadcasts; other
    // (warm, background) sessions reach maybeNotify but not the focused transcript.
    if (this.focusedId === null) this.focusedId = sid;
    if (sid === this.focusedId) {
      foldEvent(this.state, ev);
      this.broadcast({ type: "event", event: ev });
    }
    this.maybeNotify(ev);
  }

  /** Update the running set from one event and push `sessionStatus` if it changed.
   *  Snapshot-bearing events carry an authoritative status; mid-turn events
   *  (deltas, tool/user/queued) imply a live turn; failure/close end it. */
  private trackRunning(sid: SessionId, ev: SessionDriverEvent): void {
    const before = this.running.has(sid);
    const beforeInit = this.initializing.has(sid);
    switch (ev.type) {
      case "sessionOpened":
      case "sessionUpdated":
      case "runCompleted":
        this.setRunning(sid, ev.snapshot.status === "running");
        // `initializing` is a snapshot-only phase: a session is in it iff its latest
        // snapshot says so. setRunning already cleared it for the running case.
        this.setInitializing(sid, ev.snapshot.status === "initializing");
        break;
      case "assistantDelta":
      case "toolStarted":
      case "toolUpdated":
      case "userMessage":
      case "queuedMessageStarted":
        // A live mid-turn event means it's running, not warming up.
        this.setRunning(sid, true);
        break;
      case "runFailed":
      case "sessionClosed":
        this.setRunning(sid, false);
        this.setInitializing(sid, false);
        break;
    }
    if (
      this.running.has(sid) !== before ||
      this.initializing.has(sid) !== beforeInit
    )
      this.broadcastSessionStatus();
  }

  // Running and initializing are mutually exclusive phases; turning one on clears the
  // other so a row never reports both.
  private setRunning(sid: SessionId, on: boolean): void {
    if (on) {
      this.running.add(sid);
      this.initializing.delete(sid);
    } else this.running.delete(sid);
  }

  private setInitializing(sid: SessionId, on: boolean): void {
    if (on) {
      this.initializing.add(sid);
      this.running.delete(sid);
    } else this.initializing.delete(sid);
  }

  private broadcastSessionStatus(): void {
    this.broadcast({
      type: "sessionStatus",
      runningIds: [...this.running],
      initializingIds: [...this.initializing],
    });
    // The running set just changed (this is the only place it's broadcast) — match the
    // live-refresh ticker to it: start it when a turn begins, stop it when all finish.
    this.syncLiveRefresh();
  }

  /** Start/stop the live-refresh ticker to track "something is running AND someone is
   *  watching". Idempotent — safe to call on every running-set / client-set change. */
  private syncLiveRefresh(): void {
    const want = this.running.size > 0 && this.clients.size > 0;
    if (want === (this.liveTimer !== null)) return;
    if (want) {
      this.liveTimer = setInterval(() => this.liveTick(), this.liveRefreshMs);
      // Don't keep the process alive just for the ticker.
      (this.liveTimer as { unref?: () => void }).unref?.();
    } else if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
      // The ticker stopped up to one interval before the turn actually ended; a final
      // list broadcast settles the last message count (usage settles via runCompleted).
      void this.broadcastSessionList();
    }
  }

  /** One live-refresh pass: a fresh session list for every client (running rows' counts
   *  / names / previews climb) + the focused session's current context usage. */
  private liveTick(): void {
    void this.broadcastSessionList();
    this.refreshUsage();
  }

  /** Emit the focused session's current context usage as a `usageUpdated` event (folded
   *  into state + broadcast). No-op unless the focused session is the one running and the
   *  driver can report usage. A dedicated event (not a full snapshot) so a mid-turn
   *  refresh touches only `usage`, never the streaming transcript / queued / config. */
  private refreshUsage(): void {
    const ref = this.state.ref;
    if (!ref || !this.running.has(ref.sessionId)) return;
    const usage = this.driver.getUsage?.(ref.sessionId);
    if (!usage) return;
    const ev: SessionDriverEvent = {
      type: "usageUpdated",
      sessionRef: ref,
      timestamp: new Date().toISOString(),
      usage,
    };
    foldEvent(this.state, ev);
    this.broadcast({ type: "event", event: ev });
  }

  // Mirror of the client's tab-open notify rules (App.svelte), but server-side and
  // only when no client is connected — a connected client buzzes itself when
  // unfocused, and a focused client needs no buzz at all, so focus is purely a
  // client-side concern (the server can't observe it anyway).
  private maybeNotify(ev: SessionDriverEvent): void {
    // Push only when someone has been here and then left — never on a cold replay
    // (no one to "return" to a backgrounded app that was never opened).
    if (!this.notify || this.clients.size > 0 || !this.everConnected) return;
    if (ev.type === "runCompleted")
      this.notify({
        title: "pilot",
        body: "Agent finished its turn",
        tag: "pilot-run",
      });
    else if (ev.type === "runFailed")
      this.notify({ title: "pilot", body: "Run failed", tag: "pilot-run" });
    else if (ev.type === "hostUiRequest") {
      const kind = ev.request.kind;
      if (
        kind === "confirm" ||
        kind === "select" ||
        kind === "input" ||
        kind === "editor"
      ) {
        const r = ev.request as { title?: string };
        this.notify({
          title: "Approval needed",
          body: r.title ?? "Waiting on you",
          tag: "pilot-approval",
        });
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const send of this.clients) {
      try {
        send(msg);
      } catch (e) {
        console.error("[hub] send failed", e);
      }
    }
  }

  /** Fetch + broadcast the models available to switch to (driver-authoritative). */
  private async broadcastModelList(): Promise<void> {
    try {
      const models = await this.driver.listModels();
      this.broadcast({ type: "modelList", models });
    } catch (e) {
      console.error("[hub] listModels failed", e);
    }
  }

  /** Fetch + broadcast the focused session's slash commands (for the composer
   *  typeahead). Re-run on session switch since the set is cwd-scoped. */
  private async broadcastCommandList(): Promise<void> {
    try {
      const commands = await this.driver.listCommands(
        this.focusedId ?? undefined,
      );
      this.broadcast({ type: "commandList", commands });
    } catch (e) {
      console.error("[hub] listCommands failed", e);
    }
  }

  /** Fetch + broadcast the manageable providers (Settings panel). No-op if the driver
   *  doesn't support credential management. */
  private async broadcastProviderList(): Promise<void> {
    if (!this.driver.listProviders) return;
    try {
      const providers = await this.driver.listProviders();
      this.broadcast({ type: "providerList", providers });
    } catch (e) {
      console.error("[hub] listProviders failed", e);
    }
  }

  /** Fetch + broadcast pi's global model defaults + favorites (Settings panel). */
  private async broadcastModelDefaults(): Promise<void> {
    if (!this.driver.getModelDefaults) return;
    try {
      const defaults = await this.driver.getModelDefaults();
      this.broadcast({ type: "modelDefaults", defaults });
    } catch (e) {
      console.error("[hub] getModelDefaults failed", e);
    }
  }

  /** Save/remove a provider key, then refresh the provider + model lists (a key change
   *  shifts model availability and which favorites resolve). Errors go to the requester
   *  via the `error` channel — surfaced in the panel, not swallowed. */
  private async applyProviderKey(
    send: Send,
    action: () => Promise<void> | undefined,
  ): Promise<void> {
    try {
      await action();
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await this.broadcastProviderList();
    await this.broadcastModelList();
    await this.broadcastModelDefaults();
  }

  /** Run an interactive OAuth login end to end: hand the driver an IO that broadcasts
   *  each prompt + awaits the answer, report the terminal result, then refresh the
   *  provider/model lists (a fresh sign-in shifts model availability). Single-flight —
   *  a second login while one is pending is refused, so the pending map stays unambiguous. */
  private async runOAuthLogin(send: Send, providerId: string): Promise<void> {
    if (!this.driver.oauthLogin) {
      send({ type: "error", message: "this driver can't do OAuth login" });
      return;
    }
    if (this.oauthInFlight) {
      send({
        type: "error",
        message:
          "an OAuth login is already in progress — finish or cancel it first",
      });
      return;
    }
    this.oauthInFlight = true;
    const io: OAuthLoginIO = {
      prompt: (prompt) => {
        const requestId = `oauth-${this.serverId}-${++this.oauthSeq}`;
        return new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            if (this.oauthPending.delete(requestId)) {
              this.broadcast({ type: "oauthResolved", requestId });
              resolve(null); // timed out — the driver treats null as a cancel
            }
          }, OAUTH_PROMPT_TIMEOUT_MS);
          (timer as { unref?: () => void }).unref?.();
          this.oauthPending.set(requestId, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          this.broadcast({
            type: "oauthPrompt",
            requestId,
            providerId,
            prompt,
          });
        });
      },
      progress: (message) =>
        this.broadcast({ type: "oauthProgress", providerId, message }),
      deviceCode: (info) =>
        this.broadcast({ type: "oauthDeviceCode", providerId, ...info }),
    };
    try {
      await this.driver.oauthLogin(providerId, io);
      this.broadcast({ type: "oauthResult", providerId, ok: true });
    } catch (e) {
      this.broadcast({
        type: "oauthResult",
        providerId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.oauthInFlight = false;
      // Resolve (null) + dismiss any prompt still pending — a thrown/aborted login
      // shouldn't leave a dangling dialog on clients or a leaked resolver here.
      for (const [requestId, resolve] of this.oauthPending) {
        this.broadcast({ type: "oauthResolved", requestId });
        resolve(null);
      }
      this.oauthPending.clear();
    }
    await this.broadcastProviderList();
    await this.broadcastModelList();
    await this.broadcastModelDefaults();
  }

  /** Apply a defaults/favorites mutation, then re-broadcast the defaults so every
   *  client (and the header picker's favorites filter) updates. */
  private async applyModelDefaults(
    action: () => Promise<void> | undefined,
  ): Promise<void> {
    try {
      await action();
    } catch (e) {
      console.error("[hub] model-defaults mutation failed", e);
    }
    await this.broadcastModelDefaults();
  }

  /** Archive/unarchive a session, then re-broadcast the list so every client's
   *  active-only filter reflects it. Errors (e.g. an unwritable index) go back to the
   *  requester via the `error` channel — surfaced, not swallowed. */
  private async applyArchive(
    send: Send,
    path: string,
    archived: boolean,
  ): Promise<void> {
    try {
      await this.driver.setArchived?.(path, archived);
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await this.broadcastSessionList();
  }

  /** Rename a session, then re-broadcast the list so every client's sidebar reflects
   *  the new name. A warm session also emits a `sessionUpdated` (via the driver) so its
   *  header title updates live. Empty names are dropped here — clearing a name isn't a
   *  rename. Errors go back to the requester via the `error` channel. */
  private async applyRename(
    send: Send,
    path: string,
    name: string,
  ): Promise<void> {
    if (!name.trim()) return;
    try {
      await this.driver.renameSession?.(path, name.trim());
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    await this.broadcastSessionList();
  }

  /** Remove a pilot-created worktree on request (the sidebar's clean-up action). Surfaces
   *  a refusal (dirty worktree without force) as an error so the client can offer force;
   *  re-broadcasts the list either way so the indicator clears when it's gone. */
  private async applyWorktreeCleanup(
    send: Send,
    path: string,
    force?: boolean,
  ): Promise<void> {
    if (!this.driver.cleanupWorktree) {
      send({ type: "error", message: "this driver can't clean up worktrees" });
      return;
    }
    try {
      const res = await this.driver.cleanupWorktree(path, { force });
      if (!res.removed)
        send({
          type: "error",
          message: `worktree not removed: ${res.reason ?? "unknown reason"}`,
        });
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    await this.broadcastSessionList();
  }

  /** Re-scan available sessions and broadcast the list + the active session id
   *  (derived from the folded state, so the picker's "active" row is authoritative). */
  private async broadcastSessionList(): Promise<void> {
    try {
      const sessions = await this.driver.listSessions();
      this.broadcast({
        type: "sessionList",
        sessions,
        activeSessionId: this.focusedId,
        defaultNewSessionCwd: homedir(),
      });
    } catch (e) {
      console.error("[hub] listSessions failed", e);
    }
  }

  /**
   * Atomically switch the active session: run the driver swap (which resolves with
   * the new session's seed events), reset state, fold the seed, then re-snapshot all
   * clients and refresh the list. `switching` suppresses any stray events meanwhile.
   * The swap is server-authoritative — every connected client follows along.
   */
  private async switchTo(
    swap: () => Promise<SessionDriverEvent[]>,
  ): Promise<boolean> {
    if (this.switchInFlight) {
      this.broadcast({
        type: "error",
        message:
          "a session switch is already in progress — answer the trust prompt first",
      });
      return false;
    }
    this.switchInFlight = true;
    this.switching = true;
    try {
      let seed: SessionDriverEvent[];
      try {
        seed = await swap();
      } catch (e) {
        this.switching = false;
        this.broadcast({
          type: "error",
          message: `session switch failed: ${e}`,
        });
        return false;
      }
      this.state = initialSessionState();
      for (const ev of seed) foldEvent(this.state, ev);
      // Focus follows the swapped-to session; its id rides the seed's sessionOpened.
      this.focusedId = this.state.ref?.sessionId ?? this.focusedId;
      this.switching = false;
      // The seed folded directly (not via onEvent), so reconcile the running +
      // initializing sets from the swapped-to session's resolved status.
      const focusId = this.state.ref?.sessionId;
      if (focusId) {
        const before = this.running.has(focusId);
        const beforeInit = this.initializing.has(focusId);
        this.setRunning(focusId, this.state.status === "running");
        this.setInitializing(focusId, this.state.status === "initializing");
        if (
          this.running.has(focusId) !== before ||
          this.initializing.has(focusId) !== beforeInit
        )
          this.broadcastSessionStatus();
      }
      this.broadcast({ type: "snapshot", state: this.snapshot() });
      await this.broadcastSessionList();
      // Commands are cwd-scoped — the swapped-to session may expose a different set.
      await this.broadcastCommandList();
      return true;
    } finally {
      this.switchInFlight = false;
    }
  }

  /** Register a client. Synchronously sends hello + snapshot, then live events. */
  addClient(send: Send): () => void {
    this.clients.add(send);
    this.everConnected = true;
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverId: this.serverId,
    });
    send({ type: "snapshot", state: this.snapshot() });
    // Tell the fresh client what's already running / warming up (in-memory, synchronous).
    send({
      type: "sessionStatus",
      runningIds: [...this.running],
      initializingIds: [...this.initializing],
    });
    // Current desktop-update state, so a connecting client immediately shows (or hides)
    // the sidebar update card without waiting for the watcher's next poll.
    send({
      type: "updateStatus",
      available: this.updateSha !== null,
      sha: this.updateSha ?? undefined,
      applying: this.applying,
    });
    // Fire the session + model + provider lists asynchronously (driver disk/registry
    // reads); they arrive as follow-up messages, keeping hello+snapshot synchronous +
    // first.
    void this.broadcastSessionList();
    void this.broadcastModelList();
    void this.broadcastCommandList();
    void this.broadcastProviderList();
    void this.broadcastModelDefaults();
    // A client arriving while a turn is already running starts the ticker (and one
    // leaving the last viewer stops it).
    this.syncLiveRefresh();
    return () => {
      this.clients.delete(send);
      this.syncLiveRefresh();
    };
  }

  handleClient(send: Send, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
      case "ping":
        return;
      case "prompt":
        this.driver.prompt(
          msg.text,
          msg.deliverAs,
          msg.sessionId ?? this.focusedId ?? undefined,
          msg.images,
        );
        return;
      case "abort":
        this.driver.abort(msg.sessionId ?? this.focusedId ?? undefined);
        return;
      case "respondUi": {
        // First-responder-wins: only the first answer for a still-pending dialog
        // reaches the driver. A second device answering the same id is dropped, so
        // the real pi session never gets a double resolution. The dialog lives in
        // the focused session's state (the only one clients can see + answer).
        const id = msg.response.requestId;
        if (!this.state.pendingApprovals.some((p) => p.requestId === id))
          return;
        this.driver.respondUi(
          msg.response,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      }
      case "setModel":
        this.driver.setModel(
          msg.provider,
          msg.modelId,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      case "setThinking":
        this.driver.setThinking(
          msg.level,
          msg.sessionId ?? this.focusedId ?? undefined,
        );
        return;
      case "openSession":
        void this.switchTo(() => this.driver.openSession(msg.path));
        return;
      case "newSession": {
        // Deferred creation: the draft lives client-side until the user sends, so this
        // message creates the session AND carries its first prompt. Deliver the prompt
        // only after the switch lands (focusedId now points at the new session) — doing
        // it inside the driver's newSession would race the hub's atomic state reset.
        const firstPrompt = msg.prompt?.trim();
        const firstImages = msg.images;
        void this.switchTo(() =>
          this.driver.newSession({
            cwd: msg.cwd,
            worktree: msg.worktree,
            model: msg.model,
            thinking: msg.thinking,
          }),
        ).then((ok) => {
          if (ok && firstPrompt)
            this.driver.prompt(
              firstPrompt,
              undefined,
              this.focusedId ?? undefined,
              firstImages,
            );
        });
        return;
      }
      case "listSessions":
        void this.broadcastSessionList();
        return;
      case "setArchived":
        void this.applyArchive(send, msg.path, msg.archived);
        return;
      case "renameSession":
        void this.applyRename(send, msg.path, msg.name);
        return;
      case "cleanupWorktree":
        void this.applyWorktreeCleanup(send, msg.path, msg.force);
        return;
      case "listCommands":
        void this.broadcastCommandList();
        return;
      case "listProviders":
        void this.broadcastProviderList();
        void this.broadcastModelDefaults();
        return;
      case "setProviderApiKey":
        void this.applyProviderKey(send, () =>
          this.driver.setProviderApiKey?.(msg.providerId, msg.apiKey),
        );
        return;
      case "removeProviderApiKey":
        void this.applyProviderKey(send, () =>
          this.driver.removeProviderApiKey?.(msg.providerId),
        );
        return;
      case "oauthLogin":
        void this.runOAuthLogin(send, msg.providerId);
        return;
      case "oauthRespond": {
        // First-responder-wins: only the first answer for a still-pending prompt
        // reaches the driver; a second device answering the same id no-ops.
        const resolve = this.oauthPending.get(msg.requestId);
        if (!resolve) return;
        this.oauthPending.delete(msg.requestId);
        this.broadcast({ type: "oauthResolved", requestId: msg.requestId });
        resolve(msg.value);
        return;
      }
      case "oauthLogout":
        void this.applyProviderKey(send, () =>
          this.driver.oauthLogout?.(msg.providerId),
        );
        return;
      case "setDefaultModel":
        void this.applyModelDefaults(() =>
          this.driver.setDefaultModel?.(msg.provider, msg.modelId),
        );
        return;
      case "setDefaultThinking":
        void this.applyModelDefaults(() =>
          this.driver.setDefaultThinking?.(msg.level),
        );
        return;
      case "setFavoriteModels":
        void this.applyModelDefaults(() =>
          this.driver.setFavoriteModels?.(msg.refs),
        );
        return;
      case "trustResponse":
        // The driver dedups (first answer settles it); a stale/duplicate id no-ops.
        this.driver.respondTrust?.(msg.requestId, msg.choice);
        return;
      case "applyUpdate":
        // User clicked "update now". Flag it (the watcher reads it back on its next
        // /update/state poll and applies) and reflect "applying" in the card. No-op if
        // nothing is staged or an apply is already in flight.
        if (this.updateSha !== null && !this.applying) {
          this.applying = true;
          this.broadcastUpdateStatus();
        }
        return;
      case "mock":
        this.driver.runScript?.(msg.script);
        return;
      default:
        send({
          type: "error",
          message: `unknown message: ${(msg as { type: string }).type}`,
        });
    }
  }

  /** Dev/test-only: clear state, replay the initial fixture, re-snapshot clients. */
  reset(): void {
    this.state = initialSessionState();
    this.focusedId = null;
    this.running.clear();
    this.initializing.clear();
    this.updateSha = null;
    this.applying = false;
    this.driver.reset?.();
    this.broadcast({ type: "snapshot", state: this.snapshot() });
    this.broadcastSessionStatus();
  }

  /** A JSON-safe deep copy of current state (foldEvent mutates in place). */
  snapshot(): SessionState {
    return structuredClone(this.state);
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Host activity, surfaced on /health so an external poller (the desktop
   *  update-watcher, scripts/desktop/update-watcher.ts) can tell whether it may
   *  auto-apply an update or must defer to avoid interrupting a turn. `busy` is the
   *  only thing the watcher reads; the breakdown is there for eyeballing /health.
   *  `/debug/state` can't answer this — it only carries the *focused* session, so a
   *  background session running a turn would be invisible to it. */
  activity(): { running: number; initializing: number; busy: boolean } {
    return {
      running: this.running.size,
      initializing: this.initializing.size,
      busy: this.running.size + this.initializing.size > 0,
    };
  }

  /** Watcher → server: report the staged-update commit (or null when up to date), and
   *  optionally that an attempted apply failed (resets a stuck "applying" so the card
   *  offers retry). Broadcasts updateStatus on change. Returns `applying` so the watcher
   *  learns on this same poll whether the user clicked "update now". */
  reportUpdate(sha: string | null, applyFailed = false): { applying: boolean } {
    let changed = false;
    if (sha !== this.updateSha) {
      this.updateSha = sha;
      if (sha === null) this.applying = false; // applied/gone — drop any apply flag
      changed = true;
    }
    if (applyFailed && this.applying) {
      this.applying = false;
      changed = true;
    }
    if (changed) this.broadcastUpdateStatus();
    return { applying: this.applying };
  }

  private broadcastUpdateStatus(): void {
    this.broadcast({
      type: "updateStatus",
      available: this.updateSha !== null,
      sha: this.updateSha ?? undefined,
      applying: this.applying,
    });
  }
}

// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

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
import type { PilotDriver } from "./driver.js";

export type Send = (msg: ServerMessage) => void;

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

  constructor(
    private driver: PilotDriver,
    // Called on run-done / approval-needed when NO client is connected, i.e. every
    // surface is backgrounded/closed — exactly when a Web Push should reach a pocket.
    private notify?: (n: HubNotification) => void,
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
    switch (ev.type) {
      case "sessionOpened":
      case "sessionUpdated":
      case "runCompleted":
        this.setRunning(sid, ev.snapshot.status === "running");
        break;
      case "assistantDelta":
      case "toolStarted":
      case "toolUpdated":
      case "userMessage":
      case "queuedMessageStarted":
        this.setRunning(sid, true);
        break;
      case "runFailed":
      case "sessionClosed":
        this.setRunning(sid, false);
        break;
    }
    if (this.running.has(sid) !== before) this.broadcastSessionStatus();
  }

  private setRunning(sid: SessionId, on: boolean): void {
    if (on) this.running.add(sid);
    else this.running.delete(sid);
  }

  private broadcastSessionStatus(): void {
    this.broadcast({ type: "sessionStatus", runningIds: [...this.running] });
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

  /** Re-scan available sessions and broadcast the list + the active session id
   *  (derived from the folded state, so the picker's "active" row is authoritative). */
  private async broadcastSessionList(): Promise<void> {
    try {
      const sessions = await this.driver.listSessions();
      this.broadcast({
        type: "sessionList",
        sessions,
        activeSessionId: this.focusedId,
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
  ): Promise<void> {
    if (this.switchInFlight) {
      this.broadcast({
        type: "error",
        message:
          "a session switch is already in progress — answer the trust prompt first",
      });
      return;
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
        return;
      }
      this.state = initialSessionState();
      for (const ev of seed) foldEvent(this.state, ev);
      // Focus follows the swapped-to session; its id rides the seed's sessionOpened.
      this.focusedId = this.state.ref?.sessionId ?? this.focusedId;
      this.switching = false;
      // The seed folded directly (not via onEvent), so reconcile the running set
      // from the swapped-to session's resolved status.
      const focusId = this.state.ref?.sessionId;
      if (focusId) {
        const before = this.running.has(focusId);
        this.setRunning(focusId, this.state.status === "running");
        if (this.running.has(focusId) !== before) this.broadcastSessionStatus();
      }
      this.broadcast({ type: "snapshot", state: this.snapshot() });
      await this.broadcastSessionList();
      // Commands are cwd-scoped — the swapped-to session may expose a different set.
      await this.broadcastCommandList();
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
    // Tell the fresh client what's already running (in-memory, synchronous).
    send({ type: "sessionStatus", runningIds: [...this.running] });
    // Fire the session + model + provider lists asynchronously (driver disk/registry
    // reads); they arrive as follow-up messages, keeping hello+snapshot synchronous +
    // first.
    void this.broadcastSessionList();
    void this.broadcastModelList();
    void this.broadcastCommandList();
    void this.broadcastProviderList();
    void this.broadcastModelDefaults();
    return () => this.clients.delete(send);
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
      case "newSession":
        void this.switchTo(() => this.driver.newSession(msg.cwd, msg.worktree));
        return;
      case "listSessions":
        void this.broadcastSessionList();
        return;
      case "setArchived":
        void this.applyArchive(send, msg.path, msg.archived);
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
}

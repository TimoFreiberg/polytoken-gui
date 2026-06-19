import { describe, expect, test } from "bun:test";
import type {
  CommandInfo,
  FileInfo,
  HostUiResponse,
  ModelDefaults,
  ModelOption,
  ProviderInfo,
  ServerMessage,
  SessionDriverEvent,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
} from "@pilot/protocol";
import type { OAuthLoginIO, PilotDriver, TrustEvent } from "./driver.js";
import { SessionHub } from "./hub.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const ev = (e: Partial<SessionDriverEvent>): SessionDriverEvent =>
  ({ sessionRef: ref, timestamp: "t", ...e }) as SessionDriverEvent;
const evFor = (
  sessionId: string,
  e: Partial<SessionDriverEvent>,
): SessionDriverEvent =>
  ({
    sessionRef: { workspaceId: "w", sessionId },
    timestamp: "t",
    ...e,
  }) as SessionDriverEvent;
const snap = (sessionId: string): SessionSnapshot => ({
  ref: { workspaceId: "w", sessionId },
  workspace: { workspaceId: "w", path: "/w" },
  title: "t",
  status: "idle",
  updatedAt: "t",
});
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A driver we can emit into by hand, for deterministic hub tests. */
class FakeDriver implements PilotDriver {
  private listener?: (e: SessionDriverEvent) => void;
  private trustListener?: (e: TrustEvent) => void;
  readonly responded: HostUiResponse[] = [];
  readonly trustResponded: { requestId: string; choice: number | null }[] = [];
  subscribe(l: (e: SessionDriverEvent) => void) {
    this.listener = l;
    return () => {};
  }
  emit(e: SessionDriverEvent) {
    this.listener?.(e);
  }
  subscribeTrust(l: (e: TrustEvent) => void) {
    this.trustListener = l;
    return () => {};
  }
  trustEmit(e: TrustEvent) {
    this.trustListener?.(e);
  }
  respondTrust(requestId: string, choice: number | null) {
    this.trustResponded.push({ requestId, choice });
    // Mirror the real driver: settling fires a `resolved` event back through the channel.
    this.trustEmit({ kind: "resolved", requestId });
  }
  prompt(
    _text?: string,
    _deliverAs?: "steer" | "followUp",
    _sessionId?: string,
    _images?: readonly import("@pilot/protocol").ImageContent[],
  ) {}
  abort() {}
  respondUi(r: HostUiResponse) {
    this.responded.push(r);
    this.emit(ev({ type: "hostUiResolved", requestId: r.requestId }));
  }
  getUsageCalls = 0;
  getUsage() {
    this.getUsageCalls++;
    return {
      tokens: 1000 + this.getUsageCalls * 100,
      contextWindow: 200000,
      percent: 1,
    };
  }
  readonly archiveCalls: { path: string; archived: boolean }[] = [];
  async listSessions(): Promise<SessionListEntry[]> {
    return [
      {
        sessionId: "s",
        path: "/s.jsonl",
        cwd: "/w",
        preview: "a",
        userMessageCount: 1,
        updatedAt: "t",
        createdAt: "t",
        archived: this.archiveCalls.some(
          (c) => c.path === "/s.jsonl" && c.archived,
        ),
      },
      {
        sessionId: "s2",
        path: "/s2.jsonl",
        cwd: "/w",
        preview: "b",
        userMessageCount: 2,
        updatedAt: "t",
        createdAt: "t",
        archived: false,
      },
    ];
  }
  async setArchived(path: string, archived: boolean) {
    this.archiveCalls.push({ path, archived });
  }
  readonly renameCalls: { path: string; name: string }[] = [];
  async renameSession(path: string, name: string) {
    this.renameCalls.push({ path, name });
  }
  async openSession(_path: string): Promise<SessionDriverEvent[]> {
    return [
      ev({ type: "sessionOpened", snapshot: snap("s2") }),
      ev({ type: "userMessage", id: "u2", text: "new session" }),
    ];
  }
  async newSession(): Promise<SessionDriverEvent[]> {
    return [ev({ type: "sessionOpened", snapshot: snap("new") })];
  }
  readonly modelCalls: {
    provider: string;
    modelId: string;
    sessionId?: string;
  }[] = [];
  readonly thinkingCalls: { level: string; sessionId?: string }[] = [];
  async listModels(): Promise<ModelOption[]> {
    return [
      { provider: "anthropic", modelId: "claude-opus-4-8", label: "Opus" },
      { provider: "deepseek", modelId: "deepseek-v4-flash", label: "Flash" },
    ];
  }
  async listCommands(): Promise<CommandInfo[]> {
    return [{ name: "review", source: "prompt" }];
  }
  async listFiles(): Promise<FileInfo[]> {
    return [{ path: "README.md", isDirectory: false }];
  }
  setModel(provider: string, modelId: string, sessionId?: string) {
    this.modelCalls.push({ provider, modelId, sessionId });
  }
  setThinking(level: string, sessionId?: string) {
    this.thinkingCalls.push({ level, sessionId });
  }

  // --- Global provider/model config ---
  readonly providerKeyCalls: { providerId: string; apiKey: string }[] = [];
  readonly providerRemoveCalls: string[] = [];
  readonly defaultModelCalls: { provider: string; modelId: string }[] = [];
  readonly defaultThinkingCalls: string[] = [];
  readonly favoriteCalls: string[][] = [];
  async listProviders(): Promise<ProviderInfo[]> {
    return [
      {
        id: "openai",
        name: "OpenAI",
        hasAuth: false,
        authSource: "none",
        apiKeySetupSupported: true,
        oauthSupported: false,
      },
      {
        id: "anthropic",
        name: "Anthropic (Claude Pro/Max)",
        hasAuth: false,
        authSource: "none",
        apiKeySetupSupported: false,
        oauthSupported: true,
      },
    ];
  }
  async setProviderApiKey(providerId: string, apiKey: string) {
    if (!apiKey.trim()) throw new Error("API key is required");
    this.providerKeyCalls.push({ providerId, apiKey });
  }
  async removeProviderApiKey(providerId: string) {
    this.providerRemoveCalls.push(providerId);
  }
  // Drive the interactive OAuth flow deterministically: announce, surface one paste
  // prompt, accept any non-null answer, abort on cancel.
  readonly oauthLogoutCalls: string[] = [];
  async oauthLogin(providerId: string, io: OAuthLoginIO) {
    io.progress(`Opening ${providerId} authorization…`);
    const answer = await io.prompt({
      kind: "input",
      message: "Paste the authorization code",
      url: `https://example.com/oauth/authorize?p=${providerId}`,
    });
    if (answer == null) throw new Error("OAuth login cancelled");
  }
  async oauthLogout(providerId: string) {
    this.oauthLogoutCalls.push(providerId);
  }
  async getModelDefaults(): Promise<ModelDefaults> {
    return {
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      thinkingLevel: "medium",
      favorites: [],
    };
  }
  async setDefaultModel(provider: string, modelId: string) {
    this.defaultModelCalls.push({ provider, modelId });
  }
  async setDefaultThinking(level: string) {
    this.defaultThinkingCalls.push(level);
  }
  async setFavoriteModels(refs: readonly string[]) {
    this.favoriteCalls.push([...refs]);
  }
}

function client() {
  const received: ServerMessage[] = [];
  return { send: (m: ServerMessage) => received.push(m), received };
}

describe("SessionHub", () => {
  test("a new client gets hello then a snapshot", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    expect(a.received[0]?.type).toBe("hello");
    expect(a.received[1]?.type).toBe("snapshot");
  });

  test("hello exposes the stable server identity supplied by startup", () => {
    const hub = new SessionHub(
      new FakeDriver(),
      undefined,
      1000,
      "stable-server-id",
    );
    const a = client();
    hub.addClient(a.send);
    expect(a.received[0]).toEqual({
      type: "hello",
      protocolVersion: 1,
      serverId: "stable-server-id",
    });
  });

  test("events broadcast to all connected clients", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);
    d.emit(ev({ type: "assistantDelta", text: "hi", channel: "text" }));
    expect(a.received.at(-1)).toMatchObject({ type: "event" });
    expect(b.received.at(-1)).toMatchObject({ type: "event" });
  });

  test("snapshot-on-connect reflects prior events without re-sending them", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "userMessage", id: "u1", text: "earlier" }));
    const late = client();
    hub.addClient(late.send);
    const snap = late.received.find((m) => m.type === "snapshot");
    expect(snap?.type).toBe("snapshot");
    if (snap?.type === "snapshot") {
      expect(
        snap.state.items.some((i) => i.kind === "user" && i.text === "earlier"),
      ).toBe(true);
    }
    // the late client must NOT have received the prior event as a live event
    expect(late.received.some((m) => m.type === "event")).toBe(false);
  });

  test("first-responder-wins: a second answer to the same dialog is dropped", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);
    d.emit(
      ev({
        type: "hostUiRequest",
        request: { kind: "confirm", requestId: "r1", title: "t", message: "m" },
      }),
    );

    hub.handleClient(a.send, {
      type: "respondUi",
      response: { requestId: "r1", confirmed: true },
    });
    hub.handleClient(b.send, {
      type: "respondUi",
      response: { requestId: "r1", confirmed: false },
    });

    expect(d.responded).toHaveLength(1);
    expect(d.responded[0]).toMatchObject({ confirmed: true });
  });

  test("a connecting client eventually receives the session list", async () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    await flush();
    const list = a.received.find((m) => m.type === "sessionList");
    expect(list?.type).toBe("sessionList");
    if (list?.type === "sessionList")
      expect(list.sessions.length).toBeGreaterThan(0);
  });

  test("setArchived routes to the driver and re-broadcasts the session list", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, {
      type: "setArchived",
      path: "/s.jsonl",
      archived: true,
    });
    await flush();

    expect(d.archiveCalls).toEqual([{ path: "/s.jsonl", archived: true }]);
    // the refreshed list reflects the new flag
    const list = a.received.filter((m) => m.type === "sessionList").at(-1);
    expect(list?.type).toBe("sessionList");
    if (list?.type === "sessionList")
      expect(list.sessions.find((s) => s.path === "/s.jsonl")?.archived).toBe(
        true,
      );
  });

  test("renameSession routes to the driver and re-broadcasts the session list", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, {
      type: "renameSession",
      path: "/s.jsonl",
      name: "Renamed session",
    });
    await flush();

    expect(d.renameCalls).toEqual([
      { path: "/s.jsonl", name: "Renamed session" },
    ]);
    // a fresh session list follows so every client's sidebar reflects the rename
    expect(a.received.some((m) => m.type === "sessionList")).toBe(true);
  });

  test("renameSession with a blank name is a no-op (no driver call)", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, {
      type: "renameSession",
      path: "/s.jsonl",
      name: "   ",
    });
    await flush();

    expect(d.renameCalls).toHaveLength(0);
    expect(a.received.some((m) => m.type === "sessionList")).toBe(false);
  });

  test("an initializing snapshot is tracked + broadcast, distinct from running", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    a.received.length = 0;

    // A session surfaces in the initializing phase (created, pre-stream).
    d.emit(
      ev({
        type: "sessionOpened",
        snapshot: { ...snap("s"), status: "initializing" },
      }),
    );
    const st = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(st?.type).toBe("sessionStatus");
    if (st?.type === "sessionStatus") {
      expect(st.initializingIds).toContain("s");
      expect(st.runningIds).not.toContain("s");
    }

    // It begins streaming → leaves initializing, enters running.
    d.emit(ev({ type: "assistantDelta", text: "go", channel: "text" }));
    const after = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(after?.type).toBe("sessionStatus");
    if (after?.type === "sessionStatus") {
      expect(after.runningIds).toContain("s");
      expect(after.initializingIds ?? []).not.toContain("s");
    }
  });

  test("openSession resets to the new session's seed and re-snapshots clients", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "userMessage", id: "u1", text: "old session msg" }));
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "openSession", path: "/s2.jsonl" });
    await flush();

    const lastSnap = a.received.filter((m) => m.type === "snapshot").at(-1);
    expect(lastSnap?.type).toBe("snapshot");
    if (lastSnap?.type === "snapshot") {
      // old session's transcript is gone, the new seed is in
      expect(
        lastSnap.state.items.some((i) => i.text === "old session msg"),
      ).toBe(false);
      expect(lastSnap.state.items.some((i) => i.text === "new session")).toBe(
        true,
      );
    }
    // the session list now reports the switched-to session as active
    const lastList = a.received.filter((m) => m.type === "sessionList").at(-1);
    if (lastList?.type === "sessionList")
      expect(lastList.activeSessionId).toBe("s2");
  });

  test("trust requests relay to clients and responses route back to the driver", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);

    const request = {
      requestId: "t1",
      cwd: "/some/repo",
      title: "Trust this project folder?",
      options: [
        { label: "Trust this folder", trusted: true },
        { label: "Don't trust", trusted: false },
      ],
    };
    d.trustEmit({ kind: "request", request });

    // Both clients see the card (out-of-band — not folded into session state).
    for (const c of [a, b]) {
      const card = c.received.find((m) => m.type === "trustRequest");
      expect(card).toMatchObject({ requestId: "t1", cwd: "/some/repo" });
    }

    hub.handleClient(a.send, {
      type: "trustResponse",
      requestId: "t1",
      choice: 0,
    });
    expect(d.trustResponded).toEqual([{ requestId: "t1", choice: 0 }]);
    // The driver's `resolved` echo dismisses the card on every client.
    for (const c of [a, b])
      expect(c.received.some((m) => m.type === "trustResolved")).toBe(true);
  });

  test("a session switch is single-flight while one is pending", async () => {
    // A swap that never resolves models a trust card awaiting human input.
    let release: (v: SessionDriverEvent[]) => void = () => {};
    const pending = new Promise<SessionDriverEvent[]>((r) => {
      release = r;
    });
    const d = new FakeDriver();
    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () => pending;
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "openSession", path: "/a.jsonl" });
    hub.handleClient(a.send, { type: "openSession", path: "/b.jsonl" });
    await flush();

    // The second open is rejected, not run concurrently.
    expect(
      a.received.some(
        (m) => m.type === "error" && /already in progress/.test(m.message),
      ),
    ).toBe(true);

    release([ev({ type: "sessionOpened", snapshot: snap("s") })]);
  });

  test("only the focused session broadcasts to clients (D8 global focus)", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "assistantDelta", text: "focused", channel: "text" })); // focus "s"
    const a = client();
    hub.addClient(a.send);
    a.received.length = 0; // drop hello/snapshot

    // A background session's event must NOT reach the client's transcript stream.
    d.emit(
      evFor("s2", { type: "assistantDelta", text: "bg", channel: "text" }),
    );
    expect(a.received.some((m) => m.type === "event")).toBe(false);

    // A focused-session event still does.
    d.emit(ev({ type: "assistantDelta", text: "more", channel: "text" }));
    expect(a.received.some((m) => m.type === "event")).toBe(true);
  });

  test("a background turn finishing while away still notifies", () => {
    const notes: { tag?: string }[] = [];
    const d = new FakeDriver();
    const hub = new SessionHub(d, (n) => {
      notes.push(n);
    });
    const a = client();
    const leave = hub.addClient(a.send); // everConnected = true
    d.emit(ev({ type: "assistantDelta", text: "focus s", channel: "text" })); // focus "s"
    leave(); // client gone → clients.size 0

    d.emit(evFor("s2", { type: "runCompleted", snapshot: snap("s2") }));
    expect(notes.some((n) => n.tag === "pilot-run")).toBe(true);
  });

  test("running state is tracked + broadcast for background sessions too", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    d.emit(ev({ type: "assistantDelta", text: "focus", channel: "text" })); // focus "s", running
    a.received.length = 0;

    // A background session runs — not folded into the transcript (see the focus
    // test above), but its running state IS broadcast.
    d.emit(
      evFor("s2", { type: "assistantDelta", text: "bg", channel: "text" }),
    );
    const st = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(st?.type).toBe("sessionStatus");
    if (st?.type === "sessionStatus") {
      expect(st.runningIds).toContain("s2");
      expect(st.runningIds).toContain("s"); // the focused session is running too
    }

    // A further delta for an already-running session changes nothing → no re-broadcast.
    a.received.length = 0;
    d.emit(
      evFor("s2", { type: "assistantDelta", text: "more", channel: "text" }),
    );
    expect(a.received.some((m) => m.type === "sessionStatus")).toBe(false);

    // s2 finishes (idle snapshot) → leaves the set; the focused "s" stays.
    d.emit(evFor("s2", { type: "runCompleted", snapshot: snap("s2") }));
    const after = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(after?.type).toBe("sessionStatus");
    if (after?.type === "sessionStatus") {
      expect(after.runningIds).not.toContain("s2");
      expect(after.runningIds).toContain("s");
    }
  });

  test("a terminal event clears running for a background session mid-switch", async () => {
    // LRU eviction (pi-driver) disposes a warm session *inside* a swap, while
    // `switching` is true, and emits a synthetic sessionClosed for it. That must still
    // clear the cross-session running set — otherwise the evicted session shows a
    // perpetual running indicator. Regression: the `switching` guard used to sit above
    // trackRunning and dropped this update.
    let release: (v: SessionDriverEvent[]) => void = () => {};
    const pending = new Promise<SessionDriverEvent[]>((r) => {
      release = r;
    });
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    // Focus "s" and run a background "s2" — both running.
    d.emit(ev({ type: "assistantDelta", text: "focus", channel: "text" }));
    d.emit(
      evFor("s2", { type: "assistantDelta", text: "bg", channel: "text" }),
    );

    // Begin a swap that never resolves → `switching` stays true.
    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () => pending;
    hub.handleClient(a.send, { type: "openSession", path: "/x.jsonl" });
    await flush();
    a.received.length = 0;

    // The backgrounded "s2" is evicted mid-swap.
    d.emit(evFor("s2", { type: "sessionClosed", reason: "ended" }));

    const st = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(st?.type).toBe("sessionStatus");
    if (st?.type === "sessionStatus") {
      expect(st.runningIds).not.toContain("s2");
      expect(st.runningIds).toContain("s"); // the focused session is unaffected
    }

    release([ev({ type: "sessionOpened", snapshot: snap("s") })]);
  });

  test("a completed swap reconciles new focus and keeps backgrounded sessions running", async () => {
    // Companion to the mid-switch test: the round-2 reorder (trackRunning above the
    // switching guard) must not disturb a *successful* swap. The swapped-from session
    // keeps running in the warm pool, the untouched background session stays running,
    // and the swapped-to session's running state is reconciled from its seed snapshot.
    let release: (v: SessionDriverEvent[]) => void = () => {};
    const pending = new Promise<SessionDriverEvent[]>((r) => {
      release = r;
    });
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    d.emit(ev({ type: "assistantDelta", text: "focus", channel: "text" })); // focus "s"
    d.emit(
      evFor("s2", { type: "assistantDelta", text: "bg", channel: "text" }),
    ); // bg "s2"

    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () => pending;
    hub.handleClient(a.send, { type: "openSession", path: "/s3.jsonl" });
    await flush();
    a.received.length = 0;

    // The swap resolves with a mid-run seed → new focus "s3" reconciles to running.
    release([
      evFor("s3", {
        type: "sessionOpened",
        snapshot: { ...snap("s3"), status: "running" },
      }),
    ]);
    await flush();

    const st = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(st?.type).toBe("sessionStatus");
    if (st?.type === "sessionStatus") {
      expect(st.runningIds).toContain("s3"); // new focus reconciled from seed status
      expect(st.runningIds).toContain("s"); // swapped-from session still running
      expect(st.runningIds).toContain("s2"); // untouched background session
    }
  });

  test("a fresh client is told what's already running on connect", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    d.emit(ev({ type: "assistantDelta", text: "x", channel: "text" })); // "s" running

    const b = client();
    hub.addClient(b.send);
    const st = b.received.find((m) => m.type === "sessionStatus");
    expect(st?.type).toBe("sessionStatus");
    if (st?.type === "sessionStatus") expect(st.runningIds).toContain("s");
  });

  test("a connecting client eventually receives the model list", async () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    await flush();
    const list = a.received.find((m) => m.type === "modelList");
    expect(list?.type).toBe("modelList");
    if (list?.type === "modelList")
      expect(list.models.some((m) => m.modelId === "deepseek-v4-flash")).toBe(
        true,
      );
  });

  test("setModel/setThinking route to msg.sessionId, else the focused session", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "assistantDelta", text: "x", channel: "text" })); // focus "s"

    hub.handleClient(() => {}, {
      type: "setModel",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    hub.handleClient(() => {}, {
      type: "setModel",
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      sessionId: "s2",
    });
    hub.handleClient(() => {}, { type: "setThinking", level: "high" });

    expect(d.modelCalls).toEqual([
      { provider: "deepseek", modelId: "deepseek-v4-flash", sessionId: "s" },
      { provider: "anthropic", modelId: "claude-opus-4-8", sessionId: "s2" },
    ]);
    expect(d.thinkingCalls).toEqual([{ level: "high", sessionId: "s" }]);
  });

  test("a connecting client eventually receives the provider list + model defaults", async () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    await flush();
    const providers = a.received.find((m) => m.type === "providerList");
    expect(providers?.type).toBe("providerList");
    if (providers?.type === "providerList")
      expect(providers.providers.some((p) => p.id === "openai")).toBe(true);
    const defaults = a.received.find((m) => m.type === "modelDefaults");
    expect(defaults?.type).toBe("modelDefaults");
    if (defaults?.type === "modelDefaults")
      expect(defaults.defaults.modelId).toBe("claude-opus-4-8");
  });

  test("setProviderApiKey routes to the driver and rebroadcasts the provider list", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, {
      type: "setProviderApiKey",
      providerId: "openai",
      apiKey: "sk-test",
    });
    await flush();

    expect(d.providerKeyCalls).toEqual([
      { providerId: "openai", apiKey: "sk-test" },
    ]);
    // a refreshed provider + model list follows so newly-available models show up
    expect(a.received.some((m) => m.type === "providerList")).toBe(true);
    expect(a.received.some((m) => m.type === "modelList")).toBe(true);
  });

  test("a failing key set surfaces an error to the requester, no rebroadcast", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, {
      type: "setProviderApiKey",
      providerId: "openai",
      apiKey: "   ",
    });
    await flush();

    expect(d.providerKeyCalls).toHaveLength(0);
    expect(
      a.received.some(
        (m) => m.type === "error" && /API key is required/.test(m.message),
      ),
    ).toBe(true);
    expect(a.received.some((m) => m.type === "providerList")).toBe(false);
  });

  test("oauthLogin surfaces a prompt; answering it completes the login + rebroadcasts providers", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, { type: "oauthLogin", providerId: "anthropic" });
    await flush();

    const prompt = a.received.find((m) => m.type === "oauthPrompt");
    expect(prompt?.type).toBe("oauthPrompt");
    if (prompt?.type !== "oauthPrompt") throw new Error("no prompt broadcast");
    expect(prompt.providerId).toBe("anthropic");
    expect(prompt.prompt.url).toBeTruthy();
    // progress reached clients too
    expect(a.received.some((m) => m.type === "oauthProgress")).toBe(true);

    hub.handleClient(a.send, {
      type: "oauthRespond",
      requestId: prompt.requestId,
      value: "the-auth-code",
    });
    await flush();

    // the prompt is dismissed, the login reports success, and providers refresh
    expect(
      a.received.some(
        (m) => m.type === "oauthResolved" && m.requestId === prompt.requestId,
      ),
    ).toBe(true);
    expect(a.received.find((m) => m.type === "oauthResult")).toMatchObject({
      providerId: "anthropic",
      ok: true,
    });
    expect(a.received.some((m) => m.type === "providerList")).toBe(true);
  });

  test("cancelling an oauth prompt (null) fails the login", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, { type: "oauthLogin", providerId: "anthropic" });
    await flush();
    const prompt = a.received.find((m) => m.type === "oauthPrompt");
    if (prompt?.type !== "oauthPrompt") throw new Error("no prompt broadcast");

    hub.handleClient(a.send, {
      type: "oauthRespond",
      requestId: prompt.requestId,
      value: null,
    });
    await flush();

    expect(a.received.find((m) => m.type === "oauthResult")).toMatchObject({
      providerId: "anthropic",
      ok: false,
    });
  });

  test("oauthLogin is single-flight: a second login while one pends is refused", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, { type: "oauthLogin", providerId: "anthropic" });
    await flush();
    hub.handleClient(a.send, {
      type: "oauthLogin",
      providerId: "openai-codex",
    });
    await flush();

    expect(
      a.received.some(
        (m) => m.type === "error" && /already in progress/.test(m.message),
      ),
    ).toBe(true);
  });

  test("oauthLogout routes to the driver and rebroadcasts the provider list", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, { type: "oauthLogout", providerId: "anthropic" });
    await flush();

    expect(d.oauthLogoutCalls).toEqual(["anthropic"]);
    expect(a.received.some((m) => m.type === "providerList")).toBe(true);
  });

  test("default-model / thinking / favorites route to the driver and rebroadcast defaults", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();

    hub.handleClient(a.send, {
      type: "setDefaultModel",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    hub.handleClient(a.send, { type: "setDefaultThinking", level: "high" });
    hub.handleClient(a.send, {
      type: "setFavoriteModels",
      refs: ["anthropic:claude-opus-4-8"],
    });
    await flush();

    expect(d.defaultModelCalls).toEqual([
      { provider: "deepseek", modelId: "deepseek-v4-flash" },
    ]);
    expect(d.defaultThinkingCalls).toEqual(["high"]);
    expect(d.favoriteCalls).toEqual([["anthropic:claude-opus-4-8"]]);
    // each mutation re-broadcasts the defaults
    expect(
      a.received.filter((m) => m.type === "modelDefaults").length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("the live ticker refreshes the session list + focused usage mid-turn", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    // A running seed focuses "s", sets state.ref, and marks it running (as a real
    // session's sessionOpened seed does before any delta).
    d.emit(
      ev({
        type: "sessionOpened",
        snapshot: { ...snap("s"), status: "running" },
      }),
    );
    await flush();
    a.received.length = 0;

    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();

    // The meter climbs via a usageUpdated event (only usage, not a full snapshot)...
    const usageEv = a.received.find(
      (m) => m.type === "event" && m.event.type === "usageUpdated",
    );
    expect(usageEv).toBeTruthy();
    if (usageEv?.type === "event" && usageEv.event.type === "usageUpdated")
      expect(usageEv.event.usage.tokens).toBeGreaterThan(0);
    // ...and the sidebar rows refresh via a fresh session list.
    expect(a.received.some((m) => m.type === "sessionList")).toBe(true);
  });

  test("the live ticker skips usage when the focused session is idle", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    d.emit(ev({ type: "sessionOpened", snapshot: snap("s") })); // focus "s", idle
    await flush();
    a.received.length = 0;
    d.getUsageCalls = 0;

    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();

    expect(d.getUsageCalls).toBe(0);
    expect(
      a.received.some(
        (m) => m.type === "event" && m.event.type === "usageUpdated",
      ),
    ).toBe(false);
    // The list still refreshes — harmless, and covers background rows.
    expect(a.received.some((m) => m.type === "sessionList")).toBe(true);
  });

  test("the ticker runs while a turn streams and stops when it ends", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d, undefined, 10); // 10ms cadence
    const a = client();
    hub.addClient(a.send);
    d.emit(
      ev({
        type: "sessionOpened",
        snapshot: { ...snap("s"), status: "running" },
      }),
    ); // running
    await new Promise((r) => setTimeout(r, 40)); // a few ticks
    expect(d.getUsageCalls).toBeGreaterThan(0);

    // Turn ends → the ticker stops; no further usage polls after a quiet period.
    d.emit(ev({ type: "runCompleted", snapshot: snap("s") }));
    const callsAtEnd = d.getUsageCalls;
    await new Promise((r) => setTimeout(r, 40));
    expect(d.getUsageCalls).toBe(callsAtEnd);
  });

  test("commands target msg.sessionId, else the focused session", () => {
    const calls: (string | undefined)[] = [];
    class RecordingDriver extends FakeDriver {
      override prompt(
        _t: string,
        _d?: "steer" | "followUp",
        sessionId?: string,
        _images?: readonly import("@pilot/protocol").ImageContent[],
      ) {
        calls.push(sessionId);
        super.prompt(_t, _d, sessionId, _images);
      }
    }
    const d = new RecordingDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "assistantDelta", text: "x", channel: "text" })); // focus "s"

    hub.handleClient(() => {}, { type: "prompt", text: "hi" }); // → focused "s"
    hub.handleClient(() => {}, { type: "prompt", text: "yo", sessionId: "s2" });
    expect(calls).toEqual(["s", "s2"]);
  });
});

describe("desktop update relay", () => {
  const lastUpdate = (c: ReturnType<typeof client>) =>
    [...c.received].reverse().find((m) => m.type === "updateStatus") as
      | Extract<ServerMessage, { type: "updateStatus" }>
      | undefined;

  test("reportUpdate broadcasts availability to clients", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    // Connect sends a baseline updateStatus (nothing staged).
    expect(lastUpdate(a)).toMatchObject({ available: false, applying: false });

    hub.reportUpdate("abc123");
    expect(lastUpdate(a)).toMatchObject({
      available: true,
      sha: "abc123",
      applying: false,
    });
  });

  test("a client connecting after an update is staged sees the card immediately", () => {
    const hub = new SessionHub(new FakeDriver());
    hub.reportUpdate("def456");
    const late = client();
    hub.addClient(late.send);
    expect(lastUpdate(late)).toMatchObject({ available: true, sha: "def456" });
  });

  test("applyUpdate flips applying + the watcher learns it on its next report", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.reportUpdate("abc123");

    hub.handleClient(a.send, { type: "applyUpdate" });
    expect(lastUpdate(a)).toMatchObject({ available: true, applying: true });
    // The watcher's next poll (any sha report) returns applying=true → it applies.
    expect(hub.reportUpdate("abc123")).toEqual({ applying: true });
  });

  test("applyUpdate is a no-op when nothing is staged", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.handleClient(a.send, { type: "applyUpdate" });
    expect(lastUpdate(a)).toMatchObject({ available: false, applying: false });
  });

  test("reportUpdate(null) clears availability and any applying flag", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.reportUpdate("abc123");
    hub.handleClient(a.send, { type: "applyUpdate" });
    expect(hub.reportUpdate(null)).toEqual({ applying: false });
    expect(lastUpdate(a)).toMatchObject({ available: false, applying: false });
  });

  test("applyFailed un-sticks a stuck applying card (offer retry)", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.reportUpdate("abc123");
    hub.handleClient(a.send, { type: "applyUpdate" });
    expect(lastUpdate(a)).toMatchObject({ applying: true });
    // A failed apply reports back applyFailed → card returns to "update now".
    expect(hub.reportUpdate("abc123", true)).toEqual({ applying: false });
    expect(lastUpdate(a)).toMatchObject({ available: true, applying: false });
  });
});

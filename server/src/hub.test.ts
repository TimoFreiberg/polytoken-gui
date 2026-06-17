import { describe, expect, test } from "bun:test";
import type {
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
import type { PilotDriver, TrustEvent } from "./driver.js";
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
  prompt() {}
  abort() {}
  respondUi(r: HostUiResponse) {
    this.responded.push(r);
    this.emit(ev({ type: "hostUiResolved", requestId: r.requestId }));
  }
  async listSessions(): Promise<SessionListEntry[]> {
    return [
      {
        sessionId: "s",
        path: "/s.jsonl",
        cwd: "/w",
        preview: "a",
        messageCount: 1,
        updatedAt: "t",
        createdAt: "t",
      },
      {
        sessionId: "s2",
        path: "/s2.jsonl",
        cwd: "/w",
        preview: "b",
        messageCount: 2,
        updatedAt: "t",
        createdAt: "t",
      },
    ];
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

  test("commands target msg.sessionId, else the focused session", () => {
    const calls: (string | undefined)[] = [];
    class RecordingDriver extends FakeDriver {
      prompt(_t: string, _d?: "steer" | "followUp", sessionId?: string) {
        calls.push(sessionId);
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

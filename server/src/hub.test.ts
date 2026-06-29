import { describe, expect, test } from "bun:test";
import type {
  CommandInfo,
  ExtensionInfo,
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
  clientPresence?: () => boolean;
  setClientPresence(fn: () => boolean) {
    this.clientPresence = fn;
  }
  prompt(
    _text?: string,
    _deliverAs?: "steer" | "followUp",
    _sessionId?: string,
    _images?: readonly import("@pilot/protocol").ImageContent[],
    _promptId?: string,
  ) {
    return Promise.resolve();
  }
  abort() {}
  queue = {
    steering: ["Steer one"],
    followUp: ["Follow up"],
  };
  readonly clearQueueCalls: (string | undefined)[] = [];
  clearQueue(sessionId?: string) {
    this.clearQueueCalls.push(sessionId);
    const restored = this.queue;
    this.queue = { steering: [], followUp: [] };
    return restored;
  }
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
  listSessionsCalls = 0;
  async listSessions(): Promise<SessionListEntry[]> {
    this.listSessionsCalls++;
    return [
      {
        sessionId: "s",
        path: "/s.jsonl",
        cwd: "/w",
        preview: "a",
        userMessageCount: 1,
        updatedAt: "t",
        createdAt: "t",
        lastUserMessageAt: "t",
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
        lastUserMessageAt: "t",
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
  // The landing session a fresh client adopts (mirrors the mock's bootstrap). Makes
  // session "s" the default focus, so single-default tests behave like the old global
  // focus while per-client tests can switch individual connections off it.
  defaultSeed(): SessionDriverEvent[] {
    return [ev({ type: "sessionOpened", snapshot: snap("s") })];
  }
  async openSession(_path: string): Promise<SessionDriverEvent[]> {
    return [
      ev({ type: "sessionOpened", snapshot: snap("s2") }),
      ev({ type: "userMessage", id: "u2", text: "new session" }),
    ];
  }
  readonly reloadCalls: string[] = [];
  // Reload keeps the SAME session id (it re-warms the same .jsonl) — model that by
  // returning a seed for "s" with a marker message, so a test can assert the wedged
  // transcript was replaced wholesale.
  async reloadSession(path: string): Promise<SessionDriverEvent[]> {
    this.reloadCalls.push(path);
    return [
      ev({ type: "sessionOpened", snapshot: snap("s") }),
      ev({ type: "userMessage", id: "u-reloaded", text: "reloaded session" }),
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
  async listFileIndex(): Promise<{ files: FileInfo[]; truncated: boolean }> {
    return {
      files: [{ path: "README.md", isDirectory: false }],
      truncated: false,
    };
  }
  readonly fileListCalls: {
    query: string;
    sessionId?: string;
    cwd?: string;
  }[] = [];
  async listFiles(
    query: string,
    sessionId?: string,
    cwd?: string,
  ): Promise<FileInfo[]> {
    this.fileListCalls.push({ query, sessionId, cwd });
    return [{ path: "README.md", isDirectory: false }];
  }
  readonly listDirCalls: (string | undefined)[] = [];
  async listDir(path?: string): Promise<import("@pilot/protocol").DirListing> {
    this.listDirCalls.push(path);
    return { path: path ?? "/home", parent: null, entries: [] };
  }
  readonly statPathCalls: string[] = [];
  async statPath(path: string): Promise<import("@pilot/protocol").PathStat> {
    this.statPathCalls.push(path);
    return { path, exists: false, isDir: false };
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
  // --- Extensions (Settings view) ---
  readonly extensionToggleCalls: { resolvedPath: string; enabled: boolean }[] =
    [];
  private extEnabled = new Map<string, boolean>([
    ["/ext/a.ts", true],
    ["/ext/b.ts", false],
  ]);
  async listExtensions(): Promise<ExtensionInfo[]> {
    return [...this.extEnabled].map(([resolvedPath, enabled]) => ({
      resolvedPath,
      name: resolvedPath.split("/").pop() ?? resolvedPath,
      source: "user",
      enabled,
      toolCount: enabled ? 1 : 0,
      commandCount: 0,
    }));
  }
  async setExtensionEnabled(resolvedPath: string, enabled: boolean) {
    this.extensionToggleCalls.push({ resolvedPath, enabled });
    this.extEnabled.set(resolvedPath, enabled);
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
      dataDir: "",
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

  test("restoreQueue clears the target once and replies only to the requester", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);
    a.received.length = 0;
    b.received.length = 0;

    hub.handleClient(a.send, { type: "restoreQueue", sessionId: "s2" });

    expect(d.clearQueueCalls).toEqual(["s2"]);
    expect(a.received).toContainEqual({
      type: "queueRestored",
      steering: ["Steer one"],
      followUp: ["Follow up"],
    });
    expect(b.received.some((message) => message.type === "queueRestored")).toBe(
      false,
    );
  });

  test("restoreQueue returns an empty result without changing the editor contract", () => {
    const d = new FakeDriver();
    d.queue = { steering: [], followUp: [] };
    const hub = new SessionHub(d);
    const a = client();
    hub.handleClient(a.send, { type: "restoreQueue" });
    expect(a.received.at(-1)).toEqual({
      type: "queueRestored",
      steering: [],
      followUp: [],
    });
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

  test("queryFiles forwards an explicit cwd (a draft's target dir) to the driver", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, {
      type: "queryFiles",
      query: "comp",
      cwd: "/home/me/other-project",
    });
    await flush();

    expect(d.fileListCalls).toEqual([
      { query: "comp", sessionId: "s", cwd: "/home/me/other-project" },
    ]);
    expect(a.received.some((m) => m.type === "fileList")).toBe(true);
  });

  test("queryFiles without a cwd searches the focused session (cwd undefined)", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();

    hub.handleClient(a.send, { type: "queryFiles", query: "rdme" });
    await flush();

    expect(d.fileListCalls).toEqual([
      { query: "rdme", sessionId: "s", cwd: undefined },
    ]);
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

  test("reloadSession rebuilds a wedged session from a fresh seed for every viewer", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    // Wedge session "s" (the default focus both clients adopt) with a stale transcript.
    d.emit(ev({ type: "userMessage", id: "u1", text: "wedged msg" }));
    const a = client();
    const b = client();
    hub.addClient(a.send);
    hub.addClient(b.send);

    hub.handleClient(a.send, { type: "reloadSession", path: "/s.jsonl" });
    await flush();

    expect(d.reloadCalls).toEqual(["/s.jsonl"]);
    // Reseed re-snapshots EVERY viewer of the reloaded session, not just the requester,
    // so a second client looking at the broken session also recovers. The wedged
    // transcript is replaced wholesale by the fresh seed.
    for (const c of [a, b]) {
      const lastSnap = c.received.filter((m) => m.type === "snapshot").at(-1);
      expect(lastSnap?.type).toBe("snapshot");
      if (lastSnap?.type === "snapshot") {
        expect(lastSnap.state.items.some((i) => i.text === "wedged msg")).toBe(
          false,
        );
        expect(
          lastSnap.state.items.some((i) => i.text === "reloaded session"),
        ).toBe(true);
      }
    }
  });

  test("reloadSession reports an error when the driver doesn't support it", async () => {
    const d = new FakeDriver();
    (d as unknown as { reloadSession?: unknown }).reloadSession = undefined;
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "reloadSession", path: "/s.jsonl" });
    await flush();

    const err = a.received.filter((m) => m.type === "error").at(-1);
    expect(err?.type).toBe("error");
    if (err?.type === "error") expect(err.message).toMatch(/reload/i);
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

  test("client-presence predicate tracks live connections (trust deny-safe signal)", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    // The hub wires a real presence predicate at construction. The trust subscription
    // can't serve this role (it never unsubscribes), which is exactly the dead-guard bug
    // this closes: the driver must be able to deny-safe a trust card when nobody's around.
    expect(d.clientPresence).toBeDefined();
    expect(d.clientPresence!()).toBe(false); // no clients yet

    const a = client();
    const unsubA = hub.addClient(a.send);
    expect(d.clientPresence!()).toBe(true);

    const b = client();
    const unsubB = hub.addClient(b.send);
    expect(d.clientPresence!()).toBe(true);

    unsubA();
    expect(d.clientPresence!()).toBe(true); // b still connected
    unsubB();
    expect(d.clientPresence!()).toBe(false); // everyone gone → deny-safe
  });

  test("a switch arriving mid-swap is coalesced, not rejected (boot-restore-vs-click)", async () => {
    // A swap that doesn't resolve until released models pi warming on a fresh start (or a
    // trust card awaiting input). Each openSession call gets its OWN release, so we can
    // tell the queued second swap actually ran after the first finished.
    const releases: ((v: SessionDriverEvent[]) => void)[] = [];
    const d = new FakeDriver();
    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () =>
      new Promise<SessionDriverEvent[]>((r) => releases.push(r));
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    // First open (the auto boot-restore) starts warming; a second (the operator's click)
    // arrives before it finishes. Only the first swap is invoked so far — the second is
    // queued behind it.
    hub.handleClient(a.send, { type: "openSession", path: "/a.jsonl" });
    hub.handleClient(a.send, { type: "openSession", path: "/b.jsonl" });
    await flush();
    expect(releases.length).toBe(1);

    // No misleading "already in progress / answer the trust prompt" error — the click is
    // honored, not dropped.
    expect(
      a.received.some(
        (m) => m.type === "error" && /already in progress/.test(m.message),
      ),
    ).toBe(false);

    // Release the first (boot-restore) swap. Its now-superseded snapshot is suppressed,
    // and the queued second swap is dispatched.
    releases[0]!([ev({ type: "sessionOpened", snapshot: snap("a") })]);
    await flush();
    expect(releases.length).toBe(2);

    // Release the second (the click). The client lands on "b" — the last gesture wins —
    // and never saw an "a" focus snapshot flash by.
    releases[1]!([ev({ type: "sessionOpened", snapshot: snap("b") })]);
    await flush();
    const snaps = a.received.filter((m) => m.type === "snapshot");
    const last = snaps.at(-1);
    expect(last?.type === "snapshot" && last.state.ref?.sessionId).toBe("b");
    expect(
      snaps.some(
        (m) => m.type === "snapshot" && m.state.ref?.sessionId === "a",
      ),
    ).toBe(false);
  });

  test("a superseded switch's failure is suppressed, not surfaced to the client", async () => {
    // A cold-attach failure (the connection-race / lease-claim timeout path) would
    // otherwise surface as a "session switch failed" error to a client that has
    // since clicked another session. Like the success path, a superseded switch's
    // failure must be silent — the queued switch surfaces its own outcome.
    // Each openSession call gets its OWN release, so the first can reject while
    // the second is queued behind it.
    const releases: {
      resolve: (v: SessionDriverEvent[]) => void;
      reject: (e: unknown) => void;
    }[] = [];
    const d = new FakeDriver();
    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () =>
      new Promise<SessionDriverEvent[]>((resolve, reject) =>
        releases.push({ resolve, reject }),
      );
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    // First open (A) starts warming; a second (B) queues behind it.
    hub.handleClient(a.send, { type: "openSession", path: "/a.jsonl" });
    hub.handleClient(a.send, { type: "openSession", path: "/b.jsonl" });
    await flush();
    expect(releases.length).toBe(1);

    // A's attach fails (e.g. lease claim timed out). This must NOT reach the
    // client — B has superseded it.
    releases[0]!.reject(new Error("lease claim failed (0): fetch failed"));
    await flush();
    expect(
      a.received.some(
        (m) => m.type === "error" && /session switch failed/.test(m.message),
      ),
    ).toBe(false);

    // B's swap was dispatched from A's finally; release it successfully.
    expect(releases.length).toBe(2);
    releases[1]!.resolve([ev({ type: "sessionOpened", snapshot: snap("b") })]);
    await flush();

    // The client landed on B and never saw A's stale failure.
    const last = a.received.filter((m) => m.type === "snapshot").at(-1);
    expect(last?.type === "snapshot" && last.state.ref?.sessionId).toBe("b");
    expect(
      a.received.some((m) => m.type === "error"),
    ).toBe(false);
  });

  test("a switch failure surfaces a friendly, kinded error (not the raw throw)", async () => {
    // The classifier maps known daemon/lease errors to a friendly message +
    // kind:"session-switch" so the client renders a dismissible toast, not the
    // alarming generic banner. Unknown errors keep the generic banner (no kind).
    const d = new FakeDriver();
    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () =>
      Promise.reject(
        new Error("polytoken daemon failed to start: invalid config"),
      );
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "openSession", path: "/a.jsonl" });
    await flush();

    const err = a.received.find((m) => m.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.kind).toBe("session-switch");
      expect(err.message).not.toContain("polytoken daemon failed to start");
      expect(err.message).toContain("Couldn't open this session");
      expect(err.message).toContain("invalid config");
    }
  });

  test("an unrecognized switch failure keeps the generic banner (no kind)", async () => {
    const d = new FakeDriver();
    // biome-ignore lint/suspicious/noExplicitAny: test stub override
    (d as any).openSession = () =>
      Promise.reject(new Error("something completely unexpected happened"));
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "openSession", path: "/a.jsonl" });
    await flush();

    const err = a.received.find((m) => m.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.kind).toBeUndefined();
      expect(err.message).toContain("session switch failed");
      expect(err.message).toContain("something completely unexpected");
    }
  });

  test("only a client's focused session reaches its transcript stream", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send); // adopts the landing default "s"
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

  test("focus is per-connection: one client's switch doesn't move another", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send); // both adopt the landing default "s"
    hub.addClient(b.send);

    hub.handleClient(a.send, { type: "openSession", path: "/s2.jsonl" });
    await flush();

    // a's view + list highlight move to s2; b stays on s.
    const aSnap = a.received.filter((m) => m.type === "snapshot").at(-1);
    const bSnap = b.received.filter((m) => m.type === "snapshot").at(-1);
    expect(aSnap?.type === "snapshot" && aSnap.state.ref?.sessionId).toBe("s2");
    expect(bSnap?.type === "snapshot" && bSnap.state.ref?.sessionId).toBe("s");
    const aList = a.received.filter((m) => m.type === "sessionList").at(-1);
    const bList = b.received.filter((m) => m.type === "sessionList").at(-1);
    expect(aList?.type === "sessionList" && aList.activeSessionId).toBe("s2");
    expect(bList?.type === "sessionList" && bList.activeSessionId).toBe("s");

    // A live event for s reaches only b; one for s2 reaches only a.
    a.received.length = 0;
    b.received.length = 0;
    d.emit(evFor("s", { type: "assistantDelta", text: "x", channel: "text" }));
    expect(a.received.some((m) => m.type === "event")).toBe(false);
    expect(b.received.some((m) => m.type === "event")).toBe(true);

    a.received.length = 0;
    b.received.length = 0;
    d.emit(evFor("s2", { type: "assistantDelta", text: "y", channel: "text" }));
    expect(a.received.some((m) => m.type === "event")).toBe(true);
    expect(b.received.some((m) => m.type === "event")).toBe(false);
  });

  test("a dialog is answerable only by clients viewing that session", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    const b = client();
    hub.addClient(a.send); // both adopt "s"
    hub.addClient(b.send);

    // b moves to s2; a stays on s.
    hub.handleClient(b.send, { type: "openSession", path: "/s2.jsonl" });
    await flush();

    // A dialog arrives on s (a's session).
    d.emit(
      ev({
        type: "hostUiRequest",
        request: { kind: "confirm", requestId: "r9", title: "t", message: "m" },
      }),
    );

    // b (viewing s2) cannot answer it — it isn't pending in b's focused session.
    hub.handleClient(b.send, {
      type: "respondUi",
      response: { requestId: "r9", confirmed: true },
    });
    expect(d.responded).toHaveLength(0);

    // a (viewing s) can.
    hub.handleClient(a.send, {
      type: "respondUi",
      response: { requestId: "r9", confirmed: false },
    });
    expect(d.responded).toHaveLength(1);
    expect(d.responded[0]).toMatchObject({ confirmed: false });
  });

  test("a background turn finishing while away still notifies", () => {
    const notes: { tag?: string; url?: string; body: string }[] = [];
    const d = new FakeDriver();
    const hub = new SessionHub(d, (n) => {
      notes.push(n);
    });
    const a = client();
    const leave = hub.addClient(a.send); // everConnected = true
    d.emit(ev({ type: "assistantDelta", text: "focus s", channel: "text" })); // focus "s"
    leave(); // client gone → clients.size 0

    d.emit(evFor("s2", { type: "runCompleted", snapshot: snap("s2") }));
    expect(notes).toContainEqual(
      expect.objectContaining({
        tag: "pilot-run-s2",
        url: "/?session=s2",
        body: expect.stringContaining("t finished"),
      }),
    );
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
      evFor("s2", {
        type: "assistantDelta",
        timestamp: "t2",
        text: "more",
        channel: "text",
      }),
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

  test("background activity, approvals, and failures broadcast compact attention", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    d.emit(ev({ type: "assistantDelta", text: "focus", channel: "text" }));
    a.received.length = 0;

    d.emit(
      evFor("s2", {
        type: "toolStarted",
        callId: "read-1",
        toolName: "read",
        input: { path: "docs/TODO.md" },
      }),
    );
    let status = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    expect(status?.type).toBe("sessionStatus");
    if (status?.type === "sessionStatus")
      expect(
        status.attention?.find((item) => item.sessionId === "s2"),
      ).toMatchObject({
        phase: "running",
        activity: "Reading docs/TODO.md",
      });
    expect(a.received.some((m) => m.type === "event")).toBe(false);

    d.emit(
      evFor("s2", {
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId: "bg-confirm",
          title: "Approve deploy",
          message: "Ship it?",
        },
      }),
    );
    status = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    if (status?.type === "sessionStatus")
      expect(
        status.attention?.find((item) => item.sessionId === "s2"),
      ).toMatchObject({
        phase: "waiting",
        pendingCount: 1,
        pendingTitle: "Approve deploy",
      });

    d.emit(evFor("s2", { type: "hostUiResolved", requestId: "bg-confirm" }));
    status = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    if (status?.type === "sessionStatus")
      expect(
        status.attention?.find((item) => item.sessionId === "s2"),
      ).toMatchObject({
        phase: "running",
        activity: "Reading docs/TODO.md",
      });

    d.emit(
      evFor("s2", {
        type: "runFailed",
        error: { message: "Provider overloaded" },
      }),
    );
    status = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    if (status?.type === "sessionStatus")
      expect(
        status.attention?.find((item) => item.sessionId === "s2"),
      ).toMatchObject({
        phase: "failed",
        activity: "Provider overloaded",
      });
  });

  test("a fresh client receives retained cross-session attention", () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    d.emit(
      evFor("s2", {
        type: "hostUiRequest",
        request: {
          kind: "input",
          requestId: "bg-input",
          title: "Need a value",
        },
      }),
    );

    const late = client();
    hub.addClient(late.send);
    const status = late.received.find((m) => m.type === "sessionStatus");
    expect(status?.type).toBe("sessionStatus");
    if (status?.type === "sessionStatus")
      expect(
        status.attention?.find((item) => item.sessionId === "s2"),
      ).toMatchObject({
        phase: "waiting",
        pendingTitle: "Need a value",
      });
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

  // Regression for the "open an existing session shows as in-progress" bug. A
  // history seed replays assistant deltas (which leave the last bubble
  // streaming:true) but no terminal close event — so without a trailing
  // runCompleted the folded state stays streaming + turnActive. The polytoken
  // driver's reseedFromHistory appends a trailing runCompleted(idle) to settle
  // it (mirroring pi-driver's historyToEvents). This test pins the hub-side
  // contract: a seed whose snapshot is idle + a trailing runCompleted leaves the
  // session NOT running, even when the replayed transcript's last item is a
  // streaming assistant delta.
  test("a reopened idle session whose seed ends in a streaming delta settles to idle", async () => {
    const d = new FakeDriver();
    // openSession returns a sessionOpened(idle) + a replayed assistantDelta (which
    // opens a streaming:true bubble) + the trailing runCompleted(idle) the driver
    // appends to close it.
    d.openSession = async () => [
      evFor("s3", {
        type: "sessionOpened",
        snapshot: { ...snap("s3"), status: "idle" },
      }),
      evFor("s3", {
        type: "assistantDelta",
        text: "prior answer",
        channel: "text",
      }),
      evFor("s3", {
        type: "runCompleted",
        snapshot: { ...snap("s3"), status: "idle" },
      }),
    ];
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    await flush();
    a.received.length = 0;

    hub.handleClient(a.send, { type: "openSession", path: "/s3.jsonl" });
    await flush();

    // The session must NOT be in the running set.
    const st = a.received.filter((m) => m.type === "sessionStatus").at(-1);
    if (st?.type === "sessionStatus")
      expect(st.runningIds).not.toContain("s3");

    // And the folded snapshot the client adopts must report idle status with the
    // streaming bubble closed (no streaming assistant).
    const snapMsg = a.received.find(
      (m) => m.type === "snapshot",
    ) as { type: "snapshot"; state: { status: string; items: unknown[] } } | undefined;
    expect(snapMsg?.type).toBe("snapshot");
    if (snapMsg?.type === "snapshot") {
      expect(snapMsg.state.status).toBe("idle");
      const last = snapMsg.state.items[snapMsg.state.items.length - 1] as
        | { kind: string; streaming?: boolean }
        | undefined;
      expect(last?.kind).toBe("assistant");
      expect(last?.streaming).toBe(false);
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

  test("queryExtensions sends the list; setExtensionEnabled routes + re-sends it", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);

    hub.handleClient(a.send, { type: "queryExtensions" });
    await flush();
    const list = a.received.filter((m) => m.type === "extensionList").at(-1);
    expect(list?.type).toBe("extensionList");
    if (list?.type === "extensionList") {
      expect(list.extensions.map((e) => e.name)).toEqual(["a.ts", "b.ts"]);
      expect(list.extensions.find((e) => e.name === "b.ts")?.enabled).toBe(
        false,
      );
    }

    hub.handleClient(a.send, {
      type: "setExtensionEnabled",
      resolvedPath: "/ext/b.ts",
      enabled: true,
    });
    await flush();
    // The toggle reaches the driver, then re-sends the refreshed (flipped) list.
    expect(d.extensionToggleCalls).toEqual([
      { resolvedPath: "/ext/b.ts", enabled: true },
    ]);
    const after = a.received.filter((m) => m.type === "extensionList").at(-1);
    if (after?.type === "extensionList")
      expect(after.extensions.find((e) => e.name === "b.ts")?.enabled).toBe(
        true,
      );
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
    d.listSessionsCalls = 0;

    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();

    // The meter climbs via a usageUpdated event (only usage, not a full snapshot)...
    const usageEv = a.received.find(
      (m) => m.type === "event" && m.event.type === "usageUpdated",
    );
    expect(usageEv).toBeTruthy();
    if (usageEv?.type === "event" && usageEv.event.type === "usageUpdated")
      expect(usageEv.event.usage.tokens).toBeGreaterThan(0);
    // ...and the session-list scan is skipped because the sessionOpened already
    // broadcast + cleared the dirty flag, and nothing list-affecting has happened
    // since (Rec #3 throttle — a long streaming turn shouldn't re-scan disk/sec).
    expect(d.listSessionsCalls).toBe(0);
    expect(a.received.some((m) => m.type === "sessionList")).toBe(false);
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
    d.listSessionsCalls = 0;

    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();

    expect(d.getUsageCalls).toBe(0);
    expect(
      a.received.some(
        (m) => m.type === "event" && m.event.type === "usageUpdated",
      ),
    ).toBe(false);
    // The idle session's list isn't dirty either, so the scan is skipped (Rec #3).
    expect(d.listSessionsCalls).toBe(0);
    expect(a.received.some((m) => m.type === "sessionList")).toBe(false);
  });

  test("the live ticker re-scans the session list only when list content may have changed (Rec #3)", async () => {
    const d = new FakeDriver();
    const hub = new SessionHub(d);
    const a = client();
    hub.addClient(a.send);
    // A running seed marks the list dirty (sessionOpened).
    d.emit(
      ev({
        type: "sessionOpened",
        snapshot: { ...snap("s"), status: "running" },
      }),
    );
    await flush();
    a.received.length = 0;
    d.listSessionsCalls = 0;

    // First tick: dirty from sessionOpened, but that already broadcast + cleared on
    // the flush above — so a quiet tick skips the scan.
    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();
    expect(d.listSessionsCalls).toBe(0);

    // A userMessage arrives mid-turn — it CAN change sidebar content (count/preview),
    // so the next tick re-scans and re-broadcasts.
    d.emit(ev({ type: "userMessage", id: "u1", text: "more" }));
    await flush();
    a.received.length = 0;
    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();
    expect(d.listSessionsCalls).toBe(1);
    expect(a.received.some((m) => m.type === "sessionList")).toBe(true);

    // Subsequent quiet ticks (assistantDelta etc. don't change list content) skip again.
    a.received.length = 0;
    d.listSessionsCalls = 0;
    (hub as unknown as { liveTick(): void }).liveTick();
    await flush();
    expect(d.listSessionsCalls).toBe(0);
    expect(a.received.some((m) => m.type === "sessionList")).toBe(false);
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
        _promptId?: string,
      ) {
        calls.push(sessionId);
        return super.prompt(_t, _d, sessionId, _images, _promptId);
      }
    }
    const d = new RecordingDriver();
    const hub = new SessionHub(d);
    d.emit(ev({ type: "assistantDelta", text: "x", channel: "text" })); // focus "s"

    hub.handleClient(() => {}, { type: "prompt", text: "hi" }); // → focused "s"
    hub.handleClient(() => {}, { type: "prompt", text: "yo", sessionId: "s2" });
    expect(calls).toEqual(["s", "s2"]);
  });

  test("prompt ids deduplicate retries and replay the acceptance result", async () => {
    let calls = 0;
    class RecordingDriver extends FakeDriver {
      override prompt(
        _t: string,
        _d?: "steer" | "followUp",
        _sessionId?: string,
        _images?: readonly import("@pilot/protocol").ImageContent[],
        _promptId?: string,
      ) {
        calls++;
        return Promise.resolve();
      }
    }
    const hub = new SessionHub(new RecordingDriver());
    const a = client();
    hub.handleClient(a.send, {
      type: "prompt",
      promptId: "client-prompt-1",
      text: "ship it",
      sessionId: "s",
    });
    hub.handleClient(a.send, {
      type: "prompt",
      promptId: "client-prompt-1",
      text: "ship it",
      sessionId: "s",
    });
    await flush();

    expect(calls).toBe(1);
    expect(
      a.received.filter(
        (m) => m.type === "promptResult" && m.promptId === "client-prompt-1",
      ),
    ).toEqual([
      {
        type: "promptResult",
        promptId: "client-prompt-1",
        accepted: true,
        sessionId: "s",
      },
      {
        type: "promptResult",
        promptId: "client-prompt-1",
        accepted: true,
        sessionId: "s",
      },
    ]);
  });

  test("a preflight rejection is returned to the requesting client", async () => {
    class RejectingDriver extends FakeDriver {
      override prompt() {
        return Promise.reject(new Error("No API key configured"));
      }
    }
    const hub = new SessionHub(new RejectingDriver());
    const a = client();
    hub.handleClient(a.send, {
      type: "prompt",
      promptId: "client-prompt-rejected",
      text: "hello",
      sessionId: "s",
    });
    await flush();

    expect(a.received.at(-1)).toEqual({
      type: "promptResult",
      promptId: "client-prompt-rejected",
      accepted: false,
      error: "No API key configured",
    });
  });

  test("a retried create-and-prompt request creates only one session", async () => {
    let creates = 0;
    let prompts = 0;
    class RecordingDriver extends FakeDriver {
      override async newSession(): Promise<SessionDriverEvent[]> {
        creates++;
        return [ev({ type: "sessionOpened", snapshot: snap("new") })];
      }
      override prompt() {
        prompts++;
        return Promise.resolve();
      }
    }
    const hub = new SessionHub(new RecordingDriver());
    const a = client();
    const message = {
      type: "newSession" as const,
      promptId: "client-new-1",
      cwd: "/w",
      prompt: "start",
    };
    hub.handleClient(a.send, message);
    hub.handleClient(a.send, message);
    await flush();
    await flush();

    expect(creates).toBe(1);
    expect(prompts).toBe(1);
    expect(
      a.received.filter(
        (m) => m.type === "promptResult" && m.promptId === "client-new-1",
      ).length,
    ).toBe(2);
  });
});

describe("desktop update relay", () => {
  const lastUpdate = (c: ReturnType<typeof client>) =>
    [...c.received].reverse().find((m) => m.type === "updateStatus") as
      Extract<ServerMessage, { type: "updateStatus" }> | undefined;

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
    expect(hub.reportUpdate("abc123")).toEqual({
      applying: true,
      force: false,
    });
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
    expect(hub.reportUpdate(null)).toEqual({ applying: false, force: false });
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
    expect(hub.reportUpdate("abc123", true)).toEqual({
      applying: false,
      force: false,
    });
    expect(lastUpdate(a)).toMatchObject({ available: true, applying: false });
  });

  test("forceUpdate flags a force the watcher reads once, even with nothing staged", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    // Nothing staged (just pushed; the watcher hasn't fetched yet).
    hub.handleClient(a.send, { type: "forceUpdate" });
    // No card to show (nothing staged), but the next watcher poll learns force=true…
    expect(hub.reportUpdate(null)).toEqual({ applying: false, force: true });
    // …exactly once — it's read-once, so a second poll no longer reports it.
    expect(hub.reportUpdate(null)).toEqual({ applying: false, force: false });
  });

  test("forceUpdate also flips a staged card to applying (immediate feedback)", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.reportUpdate("abc123");
    hub.handleClient(a.send, { type: "forceUpdate" });
    expect(lastUpdate(a)).toMatchObject({ available: true, applying: true });
    // The watcher's next poll learns both the apply and the force.
    expect(hub.reportUpdate("abc123")).toEqual({ applying: true, force: true });
  });

  test("a failed force clears the force flag so it doesn't re-fire", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.handleClient(a.send, { type: "forceUpdate" });
    // The watcher fetched, found the commit, tried to apply, and it failed.
    expect(hub.reportUpdate("abc123", true)).toEqual({
      applying: false,
      force: false,
    });
  });

  test("desktopStale relays to clients independently of a staged TS update", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    // Baseline: not stale, nothing staged.
    expect(lastUpdate(a)).toMatchObject({
      available: false,
      desktopStale: false,
    });

    // The watcher reports a stale .app with NO staged TS commit (sha null) — the dot is
    // orthogonal to the update card.
    hub.reportUpdate(null, false, true);
    expect(lastUpdate(a)).toMatchObject({
      available: false,
      desktopStale: true,
    });

    // A later rebuild clears it.
    hub.reportUpdate(null, false, false);
    expect(lastUpdate(a)).toMatchObject({
      available: false,
      desktopStale: false,
    });
  });

  test("omitting desktopStale leaves the last value untouched (partial report)", () => {
    const hub = new SessionHub(new FakeDriver());
    const a = client();
    hub.addClient(a.send);
    hub.reportUpdate(null, false, true);
    expect(lastUpdate(a)).toMatchObject({ desktopStale: true });
    // A report that doesn't mention desktopStale (undefined) must not clear the dot.
    hub.reportUpdate("abc123");
    expect(lastUpdate(a)).toMatchObject({
      available: true,
      desktopStale: true,
    });
  });

  test("a client connecting while the .app is stale sees the dot immediately", () => {
    const hub = new SessionHub(new FakeDriver());
    hub.reportUpdate(null, false, true);
    const late = client();
    hub.addClient(late.send);
    expect(lastUpdate(late)).toMatchObject({ desktopStale: true });
  });

  test("openDataDir calls the injected opener, not the real spawn", () => {
    // Regression: the e2e settings spec clicks Reveal, which sends `openDataDir`; the
    // hub used to Bun.spawn(`open <dir>`) directly and pop real Finder windows on the
    // host. The opener is now a seam — mock mode injects a no-op, and this asserts the
    // hub honors it (no real spawn reachable from a unit test).
    const opened: string[] = [];
    const hub = new SessionHub(
      new FakeDriver(),
      undefined,
      1000,
      "stable-server-id",
      "/tmp/pilot-data",
      (dir) => opened.push(dir),
    );
    const a = client();
    hub.addClient(a.send);
    hub.handleClient(a.send, { type: "openDataDir" });
    expect(opened).toEqual(["/tmp/pilot-data"]);
    // No error surfaced: the opener ran, the graceful-degrade path stayed silent.
    expect(a.received.some((m) => m.type === "error")).toBe(false);
  });

  test("openDataDir surfaces an error when no data dir is configured", () => {
    const opened: string[] = [];
    const hub = new SessionHub(
      new FakeDriver(),
      undefined,
      1000,
      "stable-server-id",
      undefined,
      (dir) => opened.push(dir),
    );
    const a = client();
    hub.addClient(a.send);
    hub.handleClient(a.send, { type: "openDataDir" });
    expect(opened).toEqual([]);
    const err = a.received.find((m) => m.type === "error");
    expect(err?.type === "error" && err.message).toMatch(/not configured/);
  });
});

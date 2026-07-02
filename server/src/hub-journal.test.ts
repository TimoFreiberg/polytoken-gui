// Protocol v2 commit 1: the journal runs dark alongside the legacy fold. These
// tests pin the core invariant — at every instant, folding the journal's seed
// from zero reproduces exactly the state a connected client has folded — across
// every mock fixture script, the sessionReset epoch bump, the usage-ticker
// side-door, and switch/reload journal rebuilds.

import { describe, expect, test } from "bun:test";
import {
  foldEvent,
  foldAll,
  type CommandInfo,
  type FileInfo,
  type ModelOption,
  type ServerMessage,
  type SessionDriverEvent,
  type SessionState,
  type SessionUsage,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";
import { SCRIPTS, SESSION_REF } from "./fixtures.js";
import { SessionHub } from "./hub.js";

const SID = SESSION_REF.sessionId;
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const greetingSeed = (): SessionDriverEvent[] => {
  const make = SCRIPTS.greeting;
  if (!make) throw new Error("fixtures no longer export a greeting script");
  return make().map((s) => s.event);
};

const s2Seed = (title: string): SessionDriverEvent[] => [
  {
    type: "sessionOpened",
    sessionRef: { workspaceId: "w", sessionId: "s2" },
    timestamp: "t",
    snapshot: {
      ref: { workspaceId: "w", sessionId: "s2" },
      workspace: { workspaceId: "w", path: "/w" },
      title,
      status: "idle",
      updatedAt: "t",
    },
  },
  {
    type: "userMessage",
    sessionRef: { workspaceId: "w", sessionId: "s2" },
    timestamp: "t",
    id: `u-${title}`,
    text: `hello from ${title}`,
  },
];

/** Just enough driver to emit fixture events into a hub by hand. */
class ScriptedDriver implements PilotDriver {
  private listener?: (e: SessionDriverEvent) => void;
  usage: SessionUsage | undefined;
  reloadCount = 0;
  subscribe(l: (e: SessionDriverEvent) => void) {
    this.listener = l;
    return () => {};
  }
  emit(e: SessionDriverEvent) {
    this.listener?.(e);
  }
  defaultSeed(): SessionDriverEvent[] {
    return greetingSeed();
  }
  getUsage(): SessionUsage | undefined {
    return this.usage;
  }
  async openSession(_path: string): Promise<SessionDriverEvent[]> {
    return s2Seed("opened");
  }
  async reloadSession(_path: string): Promise<SessionDriverEvent[]> {
    this.reloadCount += 1;
    return s2Seed(`reloaded-${this.reloadCount}`);
  }
  async newSession(): Promise<SessionDriverEvent[]> {
    return s2Seed("created");
  }
  prompt() {
    return Promise.resolve();
  }
  abort() {}
  respondUi() {}
  async listSessions() {
    return [];
  }
  async listModels(): Promise<ModelOption[]> {
    return [];
  }
  async listCommands(): Promise<CommandInfo[]> {
    return [];
  }
  async listFacets(): Promise<string[]> {
    return [];
  }
  async listFileIndex(): Promise<{ files: FileInfo[]; truncated: boolean }> {
    return { files: [], truncated: false };
  }
  async listFiles(): Promise<FileInfo[]> {
    return [];
  }
  async listDir() {
    return { path: "/", parent: null, entries: [] };
  }
  async statPath(path: string) {
    return { path, exists: false, isDir: false };
  }
  setModel() {}
  setThinking() {}
  setFacet() {}
  setPermissionMonitor() {}
}

/** A captured client that folds exactly what the wire delivers, like the real one:
 *  fold seeds from zero and adopt the result, fold events incrementally. */
function connectClient(hub: SessionHub) {
  const received: ServerMessage[] = [];
  let state: SessionState | null = null;
  let idx = 0;
  hub.addClient((m) => received.push(m));
  const drain = (): SessionState => {
    while (idx < received.length) {
      const m = received[idx];
      idx += 1;
      if (!m) continue;
      if (m.type === "seed") state = foldAll([...m.events]);
      else if (m.type === "event" && state) foldEvent(state, m.event);
    }
    if (!state) throw new Error("client never received a seed");
    return state;
  };
  drain();
  return { received, drain };
}

function expectSeedMatchesClient(
  hub: SessionHub,
  sid: string,
  client: SessionState,
) {
  const seed = hub.seedOf(sid);
  expect(seed).not.toBeNull();
  if (!seed) return;
  expect(foldAll(seed.events)).toEqual(client);
}

describe("journal ≡ client fold, across every fixture script", () => {
  for (const name of Object.keys(SCRIPTS)) {
    test(`script "${name}"`, () => {
      const driver = new ScriptedDriver();
      const hub = new SessionHub(driver, undefined, 60_000, "test-server");
      const client = connectClient(hub);
      expectSeedMatchesClient(hub, SID, client.drain());
      const make = SCRIPTS[name];
      if (!make) throw new Error(`script ${name} disappeared`);
      for (const step of make()) {
        driver.emit(step.event);
        // The invariant must hold after EVERY event, not just at quiescence —
        // a client can connect between any two frames.
        expectSeedMatchesClient(hub, SID, client.drain());
      }
    });
  }
});

describe("sessionReset epoch bump", () => {
  test("restarts the journal but preserves carried-over meta for late joiners", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const client = connectClient(hub);

    // Build up ambient + a pending dialog + queued state, all of which the fold
    // carries across a reset while items clear.
    for (const step of SCRIPTS.ambient?.() ?? []) driver.emit(step.event);
    for (const step of SCRIPTS.confirm?.() ?? []) driver.emit(step.event);
    const before = hub.seedOf(SID);
    expect(before).not.toBeNull();

    driver.emit({
      type: "sessionReset",
      sessionRef: SESSION_REF,
      timestamp: "reset-ts",
    });
    const clientState = client.drain();
    expect(clientState.items).toEqual([]);
    const after = hub.seedOf(SID);
    expect(after).not.toBeNull();
    if (!before || !after) return;
    expect(after.epoch).toBeGreaterThan(before.epoch);
    expect(after.seq).toBe(0);
    expectSeedMatchesClient(hub, SID, clientState);

    // The driver's post-reset re-emit stamps from 1 under the new epoch.
    driver.emit({
      type: "userMessage",
      sessionRef: SESSION_REF,
      timestamp: "t2",
      id: "u-after-reset",
      text: "fresh transcript",
    });
    const resumed = hub.seedOf(SID);
    expect(resumed?.epoch).toBe(after.epoch);
    expect(resumed?.seq).toBe(1);
    expectSeedMatchesClient(hub, SID, client.drain());
  });
});

describe("usage ticker side-door", () => {
  test("synthetic usageUpdated events join the journal via ingest", async () => {
    const driver = new ScriptedDriver();
    driver.usage = { tokens: 1234, contextWindow: 200_000, percent: 0.6 };
    const hub = new SessionHub(driver, undefined, 5, "test-server");
    const client = connectClient(hub);

    // Mark the landing session running so the live ticker engages.
    driver.emit({
      type: "sessionUpdated",
      sessionRef: SESSION_REF,
      timestamp: "t-run",
      snapshot: {
        ref: SESSION_REF,
        workspace: { workspaceId: SESSION_REF.workspaceId, path: "/w" },
        title: "demo",
        status: "running",
        updatedAt: "t-run",
      },
    });
    await new Promise((r) => setTimeout(r, 40));

    const sawUsage = client.received.some(
      (m) => m.type === "event" && m.event.type === "usageUpdated",
    );
    expect(sawUsage).toBe(true);
    expectSeedMatchesClient(hub, SID, client.drain());
  });
});

describe("tail resume (hello.resume)", () => {
  const user = (id: string, text: string): SessionDriverEvent => ({
    type: "userMessage",
    sessionRef: SESSION_REF,
    timestamp: "t",
    id,
    text,
  });

  test("a matching resume replays exactly the gap — no seed", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const a = connectClient(hub);
    driver.emit(user("u1", "one"));
    // The returning client folded through here…
    const w = hub.seedOf(SID);
    expect(w).not.toBeNull();
    if (!w) return;
    const heldState = foldAll(w.events);
    // …then missed these while disconnected.
    driver.emit(user("u2", "two"));
    driver.emit(user("u3", "three"));

    const received: ServerMessage[] = [];
    hub.addClient((m) => received.push(m), {
      sessionId: SID,
      epoch: w.epoch,
      seq: w.seq,
    });
    expect(received.some((m) => m.type === "seed")).toBe(false);
    const events = received.filter(
      (m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event",
    );
    expect(events.map((m) => m.seq)).toEqual([w.seq + 1, w.seq + 2]);
    for (const m of events) foldEvent(heldState, m.event);
    expect(heldState).toEqual(a.drain());
  });

  test("an up-to-date resume replays nothing and sends no seed", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    connectClient(hub);
    driver.emit(user("u1", "one"));
    const w = hub.seedOf(SID);
    if (!w) throw new Error("no journal");
    const received: ServerMessage[] = [];
    hub.addClient((m) => received.push(m), {
      sessionId: SID,
      epoch: w.epoch,
      seq: w.seq,
    });
    expect(received.some((m) => m.type === "seed")).toBe(false);
    expect(received.some((m) => m.type === "event")).toBe(false);
  });

  test("a resume older than the ring degrades to a full seed", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    connectClient(hub);
    driver.emit(user("u1", "one"));
    const w = hub.seedOf(SID);
    if (!w) throw new Error("no journal");
    // Overflow the ring so seq w.seq+1 is evicted into the compacted prefix.
    for (let i = 0; i < 1100; i++) driver.emit(user(`bulk-${i}`, "x"));

    const received: ServerMessage[] = [];
    hub.addClient((m) => received.push(m), {
      sessionId: SID,
      epoch: w.epoch,
      seq: w.seq,
    });
    const seed = received.find(
      (m): m is Extract<ServerMessage, { type: "seed" }> => m.type === "seed",
    );
    expect(seed).toBeDefined();
    expect(seed?.sessionId).toBe(SID);
  });

  test("a resume across an epoch bump degrades to a full seed", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    connectClient(hub);
    driver.emit(user("u1", "one"));
    const w = hub.seedOf(SID);
    if (!w) throw new Error("no journal");
    driver.emit({
      type: "sessionReset",
      sessionRef: SESSION_REF,
      timestamp: "rt",
    });
    const received: ServerMessage[] = [];
    hub.addClient((m) => received.push(m), {
      sessionId: SID,
      epoch: w.epoch,
      seq: w.seq,
    });
    const seed = received.find((m) => m.type === "seed");
    expect(seed).toBeDefined();
  });

  test("a resume for an unknown session lands on the default seed", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const received: ServerMessage[] = [];
    hub.addClient((m) => received.push(m), {
      sessionId: "never-seen",
      epoch: 42,
      seq: 7,
    });
    const seed = received.find(
      (m): m is Extract<ServerMessage, { type: "seed" }> => m.type === "seed",
    );
    expect(seed?.sessionId).toBe(SID);
  });

  test("requestSeed re-sends the focused session's seed", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const received: ServerMessage[] = [];
    const send = (m: ServerMessage) => received.push(m);
    hub.addClient(send);
    driver.emit(user("u1", "one"));
    const before = received.filter((m) => m.type === "seed").length;
    hub.handleClient(send, { type: "requestSeed" });
    const seeds = received.filter(
      (m): m is Extract<ServerMessage, { type: "seed" }> => m.type === "seed",
    );
    expect(seeds.length).toBe(before + 1);
    const st = foldAll([...(seeds.at(-1)?.events ?? [])]);
    expect(st.items.some((i) => i.kind === "user" && i.text === "one")).toBe(
      true,
    );
  });

  test("live events are stamped contiguously within an epoch", () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const a = connectClient(hub);
    for (let i = 1; i <= 5; i++) driver.emit(user(`u${i}`, `m${i}`));
    const events = a.received.filter(
      (m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event",
    );
    expect(events.length).toBe(5);
    const epochs = new Set(events.map((m) => m.epoch));
    expect(epochs.size).toBe(1);
    expect(events.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("switchTo attach-window buffering", () => {
  const racedEvent: SessionDriverEvent = {
    type: "userMessage",
    sessionRef: { workspaceId: "w", sessionId: "s2" },
    timestamp: "t",
    id: "u-raced",
    text: "raced in during the swap",
  };

  test("events racing a cold open trigger exactly one seed rebuild", async () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const captured: ServerMessage[] = [];
    const send = (m: ServerMessage) => captured.push(m);
    hub.addClient(send);

    // Gate openSession so the test controls when each fetch resolves. The
    // second call's seed includes the raced message — exactly what the daemon's
    // /history returns once the fetch happens after the event landed.
    let calls = 0;
    const gates: ((seed: SessionDriverEvent[]) => void)[] = [];
    driver.openSession = () => {
      calls += 1;
      return new Promise<SessionDriverEvent[]>((resolve) => {
        gates.push(resolve);
      });
    };

    hub.handleClient(send, { type: "openSession", path: "/s2.jsonl" });
    await flush();
    expect(gates.length).toBe(1);

    // The target streams while its seed fetch is in flight.
    driver.emit(racedEvent);

    // First fetch resolves WITHOUT the raced event (it predates it).
    gates[0]?.(s2Seed("opened"));
    await flush();
    expect(calls).toBe(2);
    gates[1]?.([...s2Seed("opened"), racedEvent]);
    await flush();

    const seed = hub.seedOf("s2");
    expect(seed).not.toBeNull();
    const st = foldAll([...(seed?.events ?? [])]);
    expect(
      st.items.some(
        (i) => i.kind === "user" && i.text === "raced in during the swap",
      ),
    ).toBe(true);
    // The client adopted the rebuilt seed, not the stale first one.
    const lastSeed = [...captured]
      .reverse()
      .find(
        (m): m is Extract<ServerMessage, { type: "seed" }> => m.type === "seed",
      );
    expect(lastSeed?.sessionId).toBe("s2");
    expect(foldAll([...(lastSeed?.events ?? [])])).toEqual(st);
  });

  test("a clean cold open fetches exactly once", async () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const captured: ServerMessage[] = [];
    const send = (m: ServerMessage) => captured.push(m);
    hub.addClient(send);
    let calls = 0;
    const original = driver.openSession.bind(driver);
    driver.openSession = (path: string) => {
      calls += 1;
      return original(path);
    };
    hub.handleClient(send, { type: "openSession", path: "/s2.jsonl" });
    await flush();
    expect(calls).toBe(1);
  });

  test("raced events never re-run a non-retryable swap (newSession)", async () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const captured: ServerMessage[] = [];
    const send = (m: ServerMessage) => captured.push(m);
    hub.addClient(send);

    let calls = 0;
    const gates: ((seed: SessionDriverEvent[]) => void)[] = [];
    driver.newSession = () => {
      calls += 1;
      return new Promise<SessionDriverEvent[]>((resolve) => {
        gates.push(resolve);
      });
    };

    hub.handleClient(send, { type: "newSession" });
    await flush();
    driver.emit(racedEvent); // races the creation swap for the same sid
    gates[0]?.(s2Seed("created"));
    await flush(10);
    // A re-run would create a SECOND session — assert it never happens.
    expect(calls).toBe(1);
    expect(hub.seedOf("s2")).not.toBeNull();
  });
});

describe("switch + reload journal lifecycle", () => {
  test("first attach starts a journal; a reload reseeds it under a new epoch", async () => {
    const driver = new ScriptedDriver();
    const hub = new SessionHub(driver, undefined, 60_000, "test-server");
    const captured: ServerMessage[] = [];
    const send = (m: ServerMessage) => captured.push(m);
    const client = connectClient(hub);
    void client; // keeps the landing session viewed
    hub.addClient(send);

    hub.handleClient(send, { type: "openSession", path: "/s2.jsonl" });
    await flush();
    const opened = hub.seedOf("s2");
    expect(opened).not.toBeNull();
    const seedMsg = [...captured]
      .reverse()
      .find(
        (m): m is Extract<ServerMessage, { type: "seed" }> => m.type === "seed",
      );
    const adopted = seedMsg ? foldAll([...seedMsg.events]) : null;
    expect(adopted?.title).toBe("opened");
    if (opened && adopted) expect(foldAll(opened.events)).toEqual(adopted);

    hub.handleClient(send, { type: "reloadSession", path: "/s2.jsonl" });
    await flush();
    const reloaded = hub.seedOf("s2");
    expect(reloaded).not.toBeNull();
    if (!opened || !reloaded) return;
    expect(reloaded.epoch).toBeGreaterThan(opened.epoch);
    expect(reloaded.seq).toBe(0);
    expect(foldAll(reloaded.events).title).toBe("reloaded-1");
  });
});

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
 *  adopt snapshots wholesale, fold events incrementally. */
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
      if (m.type === "snapshot") state = m.state;
      else if (m.type === "event" && state) foldEvent(state, m.event);
    }
    if (!state) throw new Error("client never received a snapshot");
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
    const snapMsg = [...captured]
      .reverse()
      .find(
        (m): m is Extract<ServerMessage, { type: "snapshot" }> =>
          m.type === "snapshot",
      );
    expect(snapMsg?.state.title).toBe("opened");
    if (opened && snapMsg)
      expect(foldAll(opened.events)).toEqual(snapMsg.state);

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

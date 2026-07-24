// Tests for the HostCoordinator's profile CRUD methods, reconnect-required
// detection, everConnected tracking, and risk/acknowledgement delegation.
//
// Uses createFakeHostProvider — no real WebSocket, no DOM.

import { afterEach, describe, expect, test } from "bun:test";
import { HostCoordinator } from "./hosts.svelte.js";
import { createFakeHostProvider } from "./hosts/provider.js";
import type { NativeHostDescriptor, RemoteProfile } from "./hosts/types.js";
import { store } from "./store.svelte.js";

afterEach(() => {
  store.switchHost();
  localStorage.clear();
});

function descriptor(
  id: string,
  overrides: Partial<NativeHostDescriptor> = {},
): NativeHostDescriptor {
  return {
    id,
    kind: id === "local" ? "local" : "remote",
    label: `Host ${id}`,
    subtitle: "",
    state: "ready",
    wsUrl: `ws://127.0.0.1:9000/${id}`,
    ...overrides,
  };
}

function makeProfile(id: string, overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id,
    label: `Profile ${id}`,
    sshDestination: "user@host",
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: { kind: "host" },
    riskAcknowledgements: {},
    ...overrides,
  };
}

describe("HostCoordinator profile CRUD", () => {
  test("addProfile calls provider and refreshes hosts + profiles", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);

    expect(coordinator.profiles).toHaveLength(1);
    expect(coordinator.profiles[0]!.id).toBe("remote-1");
  });

  test("updateProfile calls provider and refreshes profiles", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);

    const updated = { ...profile, label: "Updated label" };
    await coordinator.updateProfile(updated);

    expect(coordinator.profiles[0]!.label).toBe("Updated label");
  });

  test("deleteProfile calls provider and refreshes profiles", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    expect(coordinator.profiles).toHaveLength(1);

    await coordinator.deleteProfile("remote-1");
    expect(coordinator.profiles).toHaveLength(0);
  });

  test("deleteProfile switches to local if the selected host is deleted", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);

    // Select remote-1 (it will connect since the fake provider sets it to ready).
    await coordinator.selectHost("remote-1");
    expect(coordinator.selectedHostId).toBe("remote-1");

    await coordinator.deleteProfile("remote-1");
    expect(coordinator.selectedHostId).toBe("local");
  });
});

describe("HostCoordinator reconnectRequired detection", () => {
  test("updateProfile sets reconnectRequired when connection-affecting fields change on a connected host", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1", { sshDestination: "user@host1" });
    await coordinator.addProfile(profile);

    // Connect the host first (the fake provider's connectHost sets it to ready).
    await coordinator.connectHost("remote-1");
    expect(coordinator.hasEverConnected("remote-1")).toBe(true);

    // Update with a connection-affecting change.
    await coordinator.updateProfile({ ...profile, sshDestination: "user@host2" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(true);
  });

  test("updateProfile does NOT set reconnectRequired when only the label changes", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    await coordinator.connectHost("remote-1");

    // Update with a non-connection-affecting change.
    await coordinator.updateProfile({ ...profile, label: "New label" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(false);
  });

  test("updateProfile does NOT set reconnectRequired when host is not connected", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    // Don't connect.

    await coordinator.updateProfile({ ...profile, sshDestination: "user@other" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(false);
  });

  test("clearReconnectRequired clears the flag", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const profile = makeProfile("remote-1");
    await coordinator.addProfile(profile);
    await coordinator.connectHost("remote-1");

    await coordinator.updateProfile({ ...profile, sshDestination: "user@host2" });
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(true);

    coordinator.clearReconnectRequired("remote-1");
    expect(coordinator.hasReconnectRequired("remote-1")).toBe(false);
  });
});

describe("HostCoordinator everConnected tracking", () => {
  test("hasEverConnected returns false before connect, true after", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    expect(coordinator.hasEverConnected("remote-1")).toBe(false);

    await coordinator.connectHost("remote-1");
    expect(coordinator.hasEverConnected("remote-1")).toBe(true);
  });
});

describe("HostCoordinator risk/acknowledgement delegation", () => {
  test("acknowledgeRisk delegates to provider", async () => {
    const { provider, setPendingRisks } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    const risk = {
      id: "risk-1",
      kind: "rootExecution" as const,
      fingerprint: "abc123",
      title: "Running as root",
      explanation: "This container runs as root",
      consequences: "Data loss possible",
      continueLabel: "Allow root",
    };
    setPendingRisks("remote-1", [risk]);

    // The fake provider's acknowledgeRisk checks the risk exists and fingerprint matches.
    await coordinator.acknowledgeRisk("remote-1", "risk-1", "abc123");
    // Should not throw.
  });

  test("cancelConnection delegates to provider and refreshes", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    await coordinator.cancelConnection("remote-1");
    // Should not throw; the fake provider sets state to disconnected.
    const summary = coordinator.summaries.find((s) => s.descriptor.id === "remote-1");
    expect(summary?.descriptor.state).toBe("disconnected");
  });

  test("resumeConnection delegates to provider", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { state: "disconnected", wsUrl: undefined }),
    ]);
    const coordinator = new HostCoordinator(provider);
    await coordinator.init();

    await coordinator.resumeConnection("remote-1");
    // Should not throw.
  });
});

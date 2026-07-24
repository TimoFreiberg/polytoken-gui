import { describe, expect, test } from "bun:test";
import { createFakeHostProvider, createSingleHostProvider } from "./provider.js";
import { createDevHostProvider } from "./dev-provider.js";
import type { NativeHostDescriptor, RemoteProfile } from "./types.js";

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

function dockerProfile(
  id: string,
  overrides: Partial<RemoteProfile> = {},
): RemoteProfile {
  return {
    id,
    label: `Docker ${id}`,
    sshDestination: "timo@dev-server",
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: {
      kind: "dockerContainer",
      containerName: "work-api",
      user: "app",
      pantokenRoot: "/srv/pantoken",
    },
    riskAcknowledgements: {},
    ...overrides,
  };
}

function hostProfile(id: string, overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id,
    label: `Host ${id}`,
    sshDestination: "timo@mac-mini.local",
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: { kind: "host" },
    riskAcknowledgements: {},
    ...overrides,
  };
}

describe("SingleHostProvider", () => {
  test("returns one descriptor, no remote management", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    const hosts = await provider.listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].id).toBe("local");
    expect(hosts[0].kind).toBe("local");
    expect(hosts[0].state).toBe("ready");
    expect(hosts[0].wsUrl).toBe("ws://127.0.0.1:8787/ws");
    expect(provider.supportsMultiHost()).toBe(false);
  });

  test("connectHost is a no-op (local is always connected)", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    await provider.connectHost("local");
    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("ready");
  });

  test("disconnectHost is a no-op", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    await provider.disconnectHost("local");
    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("ready");
  });

  test("addProfile returns the profile as-is (no remote management)", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    const profile = hostProfile("remote-1");
    const result = await provider.addProfile(profile);
    expect(result).toEqual(profile);
    // listHosts still returns only the local host.
    const hosts = await provider.listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].id).toBe("local");
  });

  test("listProfiles returns empty in single-host mode", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    const profiles = await provider.listProfiles();
    expect(profiles).toEqual([]);
  });

  test("getProfile returns null in single-host mode", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    const profile = await provider.getProfile("anything");
    expect(profile).toBeNull();
  });

  test("acknowledgeRisk / cancelConnection / resumeConnection are no-ops", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    await expect(provider.acknowledgeRisk("x", "r1", "fp")).resolves.toBeUndefined();
    await expect(provider.cancelConnection("x")).resolves.toBeUndefined();
    await expect(provider.resumeConnection("x")).resolves.toBeUndefined();
  });

  test("supportsContainerTargets returns false", () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    expect(provider.supportsContainerTargets()).toBe(false);
  });

  test("testSshAndListContainers throws", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    await expect(provider.testSshAndListContainers("host", 22)).rejects.toThrow(/Docker targets require/);
  });

  test("inspectContainer throws", async () => {
    const provider = createSingleHostProvider("ws://127.0.0.1:8787/ws");
    await expect(provider.inspectContainer("host", 22, "name")).rejects.toThrow(/Docker targets require/);
  });
});

describe("FakeHostProvider", () => {
  test("returns the injected hosts", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    const hosts = await provider.listHosts();
    expect(hosts).toHaveLength(2);
    expect(hosts.map((h) => h.id)).toEqual(["local", "remote-1"]);
    expect(provider.supportsMultiHost()).toBe(true);
  });

  test("can drive different states for two hosts independently", async () => {
    const { provider, driveState } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);

    driveState("remote-1", "failed");
    driveState("local", "ready");

    const hosts = await provider.listHosts();
    const remote = hosts.find((h) => h.id === "remote-1")!;
    const local = hosts.find((h) => h.id === "local")!;
    expect(remote.state).toBe("failed");
    expect(local.state).toBe("ready");
  });

  test("connectHost sets state to ready", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("remote-1", { kind: "remote", state: "disconnected" }),
    ]);
    await provider.connectHost("remote-1");
    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("ready");
  });

  test("disconnectHost sets state to disconnected", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("remote-1", { kind: "remote", state: "ready" }),
    ]);
    await provider.disconnectHost("remote-1");
    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("disconnected");
  });

  test("addProfile adds a new profile and getProfile retrieves it", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const profile = hostProfile("remote-2");
    await provider.addProfile(profile);

    const retrieved = await provider.getProfile("remote-2");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("remote-2");
    expect(retrieved?.label).toBe("Host remote-2");
  });

  test("addProfile stores a deep clone (mutations do not leak)", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const profile = hostProfile("remote-2");
    await provider.addProfile(profile);

    // Mutate the original after add.
    profile.label = "Mutated";
    const retrieved = await provider.getProfile("remote-2");
    expect(retrieved?.label).toBe("Host remote-2");
  });

  test("listProfiles returns all stored profiles", async () => {
    const { provider } = createFakeHostProvider(
      [descriptor("local")],
      [hostProfile("p1"), dockerProfile("p2")],
    );
    const profiles = await provider.listProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  test("updateProfile overwrites the stored profile", async () => {
    const { provider } = createFakeHostProvider(
      [descriptor("local")],
      [hostProfile("p1")],
    );
    await provider.updateProfile({ ...hostProfile("p1"), label: "Updated" });
    const retrieved = await provider.getProfile("p1");
    expect(retrieved?.label).toBe("Updated");
  });

  test("deleteProfile removes the profile and its descriptor", async () => {
    const { provider } = createFakeHostProvider(
      [descriptor("local"), descriptor("remote-1", { kind: "remote" })],
      [hostProfile("remote-1")],
    );
    await provider.deleteProfile("remote-1");
    const profiles = await provider.listProfiles();
    expect(profiles.map((p) => p.id)).not.toContain("remote-1");
    const hosts = await provider.listHosts();
    expect(hosts.map((h) => h.id)).not.toContain("remote-1");
  });

  // ── Docker preflight / awaiting acknowledgement behavior ──────────────

  test("connectHost does not throw when awaitingAcknowledgement", async () => {
    const { provider, driveState, setPendingRisks } = createFakeHostProvider([
      descriptor("docker-1", {
        kind: "remote",
        state: "connecting",
        subtitle: "work-api via dev-server",
      }),
    ]);
    setPendingRisks("docker-1", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "abc123",
        title: "Running as root",
        explanation: "The container runs as root.",
        consequences: "Root can affect the host via mounts.",
        continueLabel: "Allow root",
      },
    ]);
    driveState("docker-1", "awaitingAcknowledgement");

    // connectHost must resolve, not throw, so the UI can render the risk.
    await expect(provider.connectHost("docker-1")).resolves.toBeUndefined();

    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("awaitingAcknowledgement");
    expect(hosts[0].pendingRisks).toHaveLength(1);
    expect(hosts[0].pendingRisks![0].id).toBe("root-1");
  });

  test("connectHost does not throw during preflight phase", async () => {
    const { provider, driveState, setPreflightPhase } = createFakeHostProvider([
      descriptor("docker-1", {
        kind: "remote",
        state: "preflight",
        subtitle: "work-api via dev-server",
      }),
    ]);
    setPreflightPhase("docker-1", "locatingContainer");
    driveState("docker-1", "preflight");

    await expect(provider.connectHost("docker-1")).resolves.toBeUndefined();

    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("preflight");
    expect(hosts[0].preflightPhase).toBe("locatingContainer");
  });

  test("acknowledgeRisk validates fingerprint and records it", async () => {
    const { provider, setPendingRisks } = createFakeHostProvider([
      descriptor("docker-1", { kind: "remote", state: "awaitingAcknowledgement" }),
    ]);
    setPendingRisks("docker-1", [
      {
        id: "ephemeral-1",
        kind: "ephemeralData",
        fingerprint: "fp-aaa",
        title: "Ephemeral data",
        explanation: "Container recreation may lose data.",
        consequences: "Pantoken runtime/session state may be lost.",
        continueLabel: "Allow ephemeral",
      },
    ]);

    await provider.acknowledgeRisk("docker-1", "ephemeral-1", "fp-aaa");
    // No throw means accepted.
  });

  test("acknowledgeRisk throws on fingerprint mismatch", async () => {
    const { provider, setPendingRisks } = createFakeHostProvider([
      descriptor("docker-1", { kind: "remote", state: "awaitingAcknowledgement" }),
    ]);
    setPendingRisks("docker-1", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "fp-original",
        title: "Running as root",
        explanation: "x",
        consequences: "y",
        continueLabel: "Allow root",
      },
    ]);

    await expect(
      provider.acknowledgeRisk("docker-1", "root-1", "fp-changed"),
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  test("acknowledgeRisk throws for unknown risk id", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("docker-1", { kind: "remote", state: "awaitingAcknowledgement" }),
    ]);
    await expect(
      provider.acknowledgeRisk("docker-1", "nope", "fp"),
    ).rejects.toThrow(/no pending risk/);
  });

  test("cancelConnection disconnects and clears pending risks", async () => {
    const { provider, driveState, setPendingRisks, setPreflightPhase } =
      createFakeHostProvider([
        descriptor("docker-1", { kind: "remote", state: "awaitingAcknowledgement" }),
      ]);
    setPendingRisks("docker-1", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "fp",
        title: "x",
        explanation: "y",
        consequences: "z",
        continueLabel: "Allow",
      },
    ]);
    setPreflightPhase("docker-1", "checkingUserPermissions");
    driveState("docker-1", "awaitingAcknowledgement");

    await provider.cancelConnection("docker-1");

    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("disconnected");
    expect(hosts[0].pendingRisks).toBeUndefined();
    expect(hosts[0].preflightPhase).toBeUndefined();
  });

  test("resumeConnection advances from awaitingAcknowledgement to ready", async () => {
    const { provider, driveState, setPendingRisks } = createFakeHostProvider([
      descriptor("docker-1", { kind: "remote", state: "awaitingAcknowledgement" }),
    ]);
    setPendingRisks("docker-1", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "fp",
        title: "x",
        explanation: "y",
        consequences: "z",
        continueLabel: "Allow",
      },
    ]);
    driveState("docker-1", "awaitingAcknowledgement");

    await provider.resumeConnection("docker-1");

    const hosts = await provider.listHosts();
    expect(hosts[0].state).toBe("ready");
    expect(hosts[0].pendingRisks).toBeUndefined();
  });

  test("getProfile on fake returns stored docker profile with advanced fields", async () => {
    const { provider } = createFakeHostProvider(
      [descriptor("local")],
      [dockerProfile("docker-1")],
    );
    const profile = await provider.getProfile("docker-1");
    expect(profile).not.toBeNull();
    expect(profile?.executionTarget.kind).toBe("dockerContainer");
    if (profile?.executionTarget.kind === "dockerContainer") {
      expect(profile.executionTarget.containerName).toBe("work-api");
      expect(profile.executionTarget.user).toBe("app");
      expect(profile.executionTarget.pantokenRoot).toBe("/srv/pantoken");
    }
  });

  test("supportsContainerTargets returns true", () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    expect(provider.supportsContainerTargets()).toBe(true);
  });

  test("testSshAndListContainers returns injected data", async () => {
    const { provider, setContainerPicker } = createFakeHostProvider([descriptor("local")]);
    setContainerPicker("test", [
      { name: "my-container", image: "alpine", state: "running", configuredUser: "root" },
    ]);
    const result = await provider.testSshAndListContainers("user@host", 22);
    expect(result.sshOk).toBe(true);
    expect(result.dockerPermission).toBe("granted");
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0].name).toBe("my-container");
  });

  test("inspectContainer returns canned inspection", async () => {
    const { provider, setInspection } = createFakeHostProvider([descriptor("local")]);
    setInspection("custom", {
      name: "custom",
      containerId: "id-custom",
      image: "alpine",
      running: true,
      configuredUser: "root",
      resolvedUser: "root",
      resolvedUid: 0,
      resolvedGid: 0,
      resolvedHome: "/root",
      pantokenRootSuggestion: "/root/.local/share/pantoken",
      mounts: [],
    });
    const insp = await provider.inspectContainer("user@host", 22, "custom");
    expect(insp.resolvedUser).toBe("root");
    expect(insp.resolvedUid).toBe(0);
  });
});

describe("DevHostProvider", () => {
  test("exposes independent fixtures and routes activity through its sink", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    const messages: Array<{ id: string; message: unknown }> = [];
    provider.setMessageSink((id, message) => messages.push({ id, message }));
    expect(provider.supportsMultiHost()).toBe(true);
    expect((await provider.listHosts()).map((host) => host.id)).toEqual(["local", "dev-remote"]);
    provider.setState("dev-remote", "failed");
    expect((await provider.listHosts()).find((host) => host.id === "dev-remote")?.state).toBe("failed");
    provider.setActivity("dev-remote", { running: true, unseen: false, waiting: false, failed: false });
    expect(messages.at(-1)?.id).toBe("dev-remote");
    expect((messages.at(-1)?.message as { type: string }).type).toBe("sessionStatus");
  });

  test("supportsContainerTargets returns true", () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    expect(provider.supportsContainerTargets()).toBe(true);
  });

  test("testSshAndListContainers returns injected containers", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    const result = await provider.testSshAndListContainers("dev@host", 22);
    expect(result.sshOk).toBe(true);
    expect(result.dockerPermission).toBe("granted");
    expect(result.containers.length).toBeGreaterThan(0);
    expect(result.containers[0].name).toBe("work-api-dev");
  });

  test("testSshAndListContainers returns injected container list", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    provider.setContainerPicker("test", [
      { name: "custom-container", image: "alpine", state: "running", configuredUser: "root" },
    ]);
    const result = await provider.testSshAndListContainers("dev@host", 22);
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0].name).toBe("custom-container");
  });

  test("inspectContainer returns canned inspection", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    const insp = await provider.inspectContainer("dev@host", 22, "work-api-dev");
    expect(insp.name).toBe("work-api-dev");
    expect(insp.resolvedUser).toBe("dev");
    expect(insp.resolvedUid).toBe(1000);
  });

  test("inspectContainer returns injected inspection", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    provider.setInspection("custom", {
      name: "custom",
      containerId: "custom-id",
      image: "alpine",
      running: true,
      configuredUser: "root",
      resolvedUser: "root",
      resolvedUid: 0,
      resolvedGid: 0,
      resolvedHome: "/root",
      pantokenRootSuggestion: "/root/.local/share/pantoken",
      mounts: [],
    });
    const insp = await provider.inspectContainer("dev@host", 22, "custom");
    expect(insp.resolvedUser).toBe("root");
    expect(insp.resolvedUid).toBe(0);
  });

  test("setPendingRisks + acknowledgeRisk drive awaitingAcknowledgement state", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    provider.setPendingRisks("dev-remote", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "fp-test",
        title: "Agent runs as root",
        explanation: "The container runs as root.",
        consequences: "Root can affect the host.",
        continueLabel: "Allow root",
      },
    ]);
    await provider.connectHost("dev-remote");
    const hosts = await provider.listHosts();
    expect(hosts.find((h) => h.id === "dev-remote")?.state).toBe("awaitingAcknowledgement");

    await provider.acknowledgeRisk("dev-remote", "root-1", "fp-test");
    // All risks acknowledged — resumeConnection should transition to provisioning.
    await provider.resumeConnection("dev-remote");
    const hosts2 = await provider.listHosts();
    expect(hosts2.find((h) => h.id === "dev-remote")?.state).toBe("provisioning");
  });

  test("driveProvisioningPhase transitions to ready at phase 4", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    provider.driveProvisioningPhase("dev-remote", 2);
    let hosts = await provider.listHosts();
    expect(hosts.find((h) => h.id === "dev-remote")?.state).toBe("provisioning");

    provider.driveProvisioningPhase("dev-remote", 4);
    hosts = await provider.listHosts();
    expect(hosts.find((h) => h.id === "dev-remote")?.state).toBe("ready");
  });

  test("driveReplacement sets reconnecting state", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    provider.driveReplacement("dev-remote");
    const hosts = await provider.listHosts();
    expect(hosts.find((h) => h.id === "dev-remote")?.state).toBe("reconnecting");
  });

  test("addProfile for docker creates a docker host descriptor", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    await provider.addProfile({
      id: "docker-test",
      label: "Test Docker",
      sshDestination: "dev@dev-server",
      polytokenPolicy: "requireExisting",
      xdgMode: "isolated",
      executionTarget: {
        kind: "dockerContainer",
        containerName: "work-api",
        user: "dev",
        pantokenRoot: "/home/dev/.local/share/pantoken",
      },
      riskAcknowledgements: {},
    });
    const hosts = await provider.listHosts();
    const dockerHost = hosts.find((h) => h.id === "docker-test");
    expect(dockerHost).toBeDefined();
    expect(dockerHost?.isDockerTarget).toBe(true);
    expect(dockerHost?.subtitle).toContain("work-api via");
  });

  test("acknowledgeRisk throws on fingerprint mismatch", async () => {
    const provider = createDevHostProvider("ws://127.0.0.1:9000/ws");
    provider.setPendingRisks("dev-remote", [
      {
        id: "root-1",
        kind: "rootExecution",
        fingerprint: "fp-original",
        title: "x",
        explanation: "y",
        consequences: "z",
        continueLabel: "Allow",
      },
    ]);
    await expect(
      provider.acknowledgeRisk("dev-remote", "root-1", "fp-wrong"),
    ).rejects.toThrow(/fingerprint mismatch/);
  });
});

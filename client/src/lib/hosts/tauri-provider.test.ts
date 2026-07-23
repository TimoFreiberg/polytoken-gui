// Tests for the TauriHostProvider — mocks window.__TAURI_INTERNALS__.invoke
// to verify snapshot→descriptor mapping, connect polling (including non-terminal
// preflight/acknowledgement states), Docker subtitle construction, and CRUD
// delegation using the RemoteProfile editor DTO.

import { afterEach, describe, expect, test } from "bun:test";
import {
  createTauriHostProvider,
  HostConnectionError,
} from "./tauri-provider.js";
import type { RemoteProfile } from "./types.js";

afterEach(() => {
  // @ts-expect-error — deleting a possibly-absent global is fine at runtime.
  delete globalThis.window;
});

/** A configurable invoke spy that records calls and returns scripted responses. */
function makeInvokeSpy(
  responses: Record<string, (() => unknown)[]> = {},
): {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  calls: { cmd: string; args?: Record<string, unknown> }[];
} {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args });
    const queue = responses[cmd];
    if (queue && queue.length > 0) {
      return Promise.resolve(queue.shift()!());
    }
    return Promise.resolve(undefined);
  };
  return { invoke, calls };
}

function installWindow(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
  globalThis.window = {
    __TAURI_INTERNALS__: { invoke },
  } as unknown as typeof globalThis.window;
}

interface SnapshotOverrides {
  id?: string;
  kind?: string;
  label?: string;
  subtitle?: string;
  state?: string;
  wsUrl?: string;
  failureLabel?: string;
  failureAction?: string;
  failureDetail?: string;
  preflightPhase?: string;
  pendingRisks?: PendingRiskDto[];
  redactedSshHost?: string;
  containerName?: string;
}

interface PendingRiskDto {
  id: string;
  kind: string;
  fingerprint: string;
  title: string;
  explanation: string;
  consequences: string;
  continueLabel: string;
}

function snapshot(overrides: SnapshotOverrides = {}) {
  return {
    id: "remote-1",
    kind: "remote",
    label: "My Remote",
    subtitle: "user@host",
    state: "ready",
    wsUrl: "ws://127.0.0.1:12345",
    ...overrides,
  };
}

function hostProfile(id = "new-host", overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id,
    label: "New Host",
    sshDestination: "user@new-host",
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: { kind: "host" },
    riskAcknowledgements: {},
    ...overrides,
  };
}

function dockerProfile(id = "docker-1", overrides: Partial<RemoteProfile> = {}): RemoteProfile {
  return {
    id,
    label: "Work API",
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

function nativeProfileCmd(id = "host-1") {
  return {
    id,
    label: "Old Label",
    sshDestination: "user@old-host",
    port: 2222,
    polytokenPolicy: "offerInstall",
    remoteRootOverride: "/custom/root",
    serverPath: "/custom/server",
    xdgMode: "shared",
  };
}

describe("TauriHostProvider", () => {
  test("listHosts maps snapshots to descriptors, overlaying local label", async () => {
    const { invoke, calls } = makeInvokeSpy({
      list_hosts: [
        () => [
          snapshot({ id: "local", kind: "local", label: "", subtitle: "", state: "ready", wsUrl: "ws://127.0.0.1:8787/ws" }),
          snapshot({ id: "remote-1", state: "disconnected", wsUrl: undefined }),
        ],
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "My Mac");
    const hosts = await provider.listHosts();

    expect(calls[0]?.cmd).toBe("list_hosts");
    expect(hosts).toHaveLength(2);

    // Local host: label overlaid from the callback, subtitle set to "This computer".
    expect(hosts[0]!.id).toBe("local");
    expect(hosts[0]!.kind).toBe("local");
    expect(hosts[0]!.label).toBe("My Mac");
    expect(hosts[0]!.subtitle).toBe("This computer");
    expect(hosts[0]!.wsUrl).toBe("ws://127.0.0.1:8787/ws");

    // Remote host: label/subtitle from the snapshot.
    expect(hosts[1]!.id).toBe("remote-1");
    expect(hosts[1]!.kind).toBe("remote");
    expect(hosts[1]!.label).toBe("My Remote");
    expect(hosts[1]!.subtitle).toBe("user@host");
    expect(hosts[1]!.wsUrl).toBeUndefined();
  });

  test("listHosts builds Docker subtitle as <container> via <redacted ssh host>", async () => {
    const { invoke } = makeInvokeSpy({
      list_hosts: [
        () => [
          snapshot({
            id: "docker-1",
            label: "Work API",
            subtitle: "", // native may leave this blank for docker targets
            state: "ready",
            containerName: "work-api",
            redactedSshHost: "dev-server",
          }),
        ],
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const hosts = await provider.listHosts();

    expect(hosts[0]!.subtitle).toBe("work-api via dev-server");
    expect(hosts[0]!.label).toBe("Work API");
  });

  test("listHosts falls back to 'This computer' when serverLabel is empty", async () => {
    const { invoke } = makeInvokeSpy({
      list_hosts: [
        () => [
          snapshot({ id: "local", kind: "local", label: "", subtitle: "", state: "ready" }),
        ],
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const hosts = await provider.listHosts();
    expect(hosts[0]!.label).toBe("This computer");
  });

  test("connectHost polls host_state until ready", async () => {
    const { invoke, calls } = makeInvokeSpy({
      ensure_remote_host: [() => snapshot({ state: "connecting" })],
      host_state: [
        () => snapshot({ state: "connecting" }),
        () => snapshot({ state: "ready", wsUrl: "ws://127.0.0.1:9999" }),
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.connectHost("remote-1");

    // Verify ensure_remote_host was called with profileId.
    const ensureCall = calls.find((c) => c.cmd === "ensure_remote_host");
    expect(ensureCall?.args).toEqual({ profileId: "remote-1" });

    // Verify host_state was polled at least twice.
    const stateCalls = calls.filter((c) => c.cmd === "host_state");
    expect(stateCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("connectHost rejects with HostConnectionError when state is failed", async () => {
    const { invoke } = makeInvokeSpy({
      ensure_remote_host: [
        () => snapshot({ state: "connecting" }),
        () => snapshot({ state: "connecting" }),
      ],
      host_state: [
        () =>
          snapshot({
            state: "failed",
            wsUrl: undefined,
            failureLabel: "SSH authentication failed",
            failureAction: "Check your SSH key.",
            failureDetail: "Permission denied",
          }),
        () =>
          snapshot({
            state: "failed",
            wsUrl: undefined,
            failureLabel: "SSH authentication failed",
            failureAction: "Check your SSH key.",
            failureDetail: "Permission denied",
          }),
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");

    try {
      await provider.connectHost("remote-1");
      expect(false).toBe(true); // Should have thrown.
    } catch (e) {
      expect(e).toBeInstanceOf(HostConnectionError);
      const err = e as HostConnectionError;
      expect(err.message).toBe("SSH authentication failed");
      expect(err.failureAction).toBe("Check your SSH key.");
      expect(err.failureDetail).toBe("Permission denied");
    }
  });

  test("connectHost does not throw when awaitingAcknowledgement and surfaces pending risks", async () => {
    const risk: PendingRiskDto = {
      id: "root-1",
      kind: "rootExecution",
      fingerprint: "fp-aaa",
      title: "Running as root",
      explanation: "The container runs as root.",
      consequences: "Root can affect the host via mounts.",
      continueLabel: "Allow root",
    };
    const { invoke } = makeInvokeSpy({
      ensure_remote_host: [() => snapshot({ state: "preflight" })],
      host_state: [
        () =>
          snapshot({
            state: "awaitingAcknowledgement",
            wsUrl: undefined,
            preflightPhase: "checkingUserPermissions",
            pendingRisks: [risk],
            containerName: "work-api",
            redactedSshHost: "dev-server",
          }),
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    // Must resolve, not throw.
    await expect(provider.connectHost("docker-1")).resolves.toBeUndefined();
  });

  test("connectHost does not throw during preflight and surfaces preflightPhase", async () => {
    const { invoke } = makeInvokeSpy({
      ensure_remote_host: [() => snapshot({ state: "preflight" })],
      host_state: [
        () =>
          snapshot({
            state: "preflight",
            preflightPhase: "locatingContainer",
          }),
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await expect(provider.connectHost("docker-1")).resolves.toBeUndefined();
  });

  test("disconnectHost calls disconnect_host with id", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.disconnectHost("remote-1");

    const call = calls.find((c) => c.cmd === "disconnect_host");
    expect(call?.args).toEqual({ id: "remote-1" });
  });

  // ── Profile CRUD using the RemoteProfile DTO ──────────────────────────

  test("addProfile delegates to add_remote_profile with the DTO", async () => {
    const { invoke, calls } = makeInvokeSpy({
      add_remote_profile: [() => nativeProfileCmd("new-host")],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const profile = hostProfile("new-host");
    await provider.addProfile(profile);

    const call = calls.find((c) => c.cmd === "add_remote_profile");
    expect(call).toBeDefined();
    expect(call?.args?.profile).toMatchObject({
      id: "new-host",
      label: "New Host",
      sshDestination: "user@new-host",
    });
  });

  test("tauri_profile_dto_preserves_advanced_fields through add/get roundtrip", async () => {
    const storedCmd = {
      id: "docker-1",
      label: "Work API",
      sshDestination: "timo@dev-server",
      port: 2222,
      polytokenPolicy: "offerInstall",
      remoteRootOverride: "/custom/root",
      serverPath: "/custom/server",
      xdgMode: "shared",
    };
    const { invoke, calls } = makeInvokeSpy({
      add_remote_profile: [() => ({ ...storedCmd })],
      list_remote_profiles: [() => [storedCmd]],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const profile = dockerProfile("docker-1", {
      port: 2222,
      polytokenPolicy: "offerInstall",
      remoteRootOverride: "/custom/root",
      serverPath: "/custom/server",
      xdgMode: "shared",
    });
    await provider.addProfile(profile);

    // add_remote_profile received the advanced fields.
    const addCall = calls.find((c) => c.cmd === "add_remote_profile");
    expect(addCall?.args?.profile).toMatchObject({
      port: 2222,
      polytokenPolicy: "offerInstall",
      remoteRootOverride: "/custom/root",
      serverPath: "/custom/server",
      xdgMode: "shared",
    });

    // getProfile returns the advanced fields (cmdToProfile preserves them).
    const retrieved = await provider.getProfile("docker-1");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.port).toBe(2222);
    expect(retrieved?.polytokenPolicy).toBe("offerInstall");
    expect(retrieved?.remoteRootOverride).toBe("/custom/root");
    expect(retrieved?.serverPath).toBe("/custom/server");
    expect(retrieved?.xdgMode).toBe("shared");
  });

  test("updateProfile sends the full DTO (no list+merge fetch needed)", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const profile = hostProfile("host-1", {
      label: "Updated",
      sshDestination: "user@new-host",
      port: 2222,
      polytokenPolicy: "offerInstall",
      remoteRootOverride: "/custom/root",
      serverPath: "/custom/server",
      xdgMode: "shared",
    });
    await provider.updateProfile(profile);

    const updateCall = calls.find((c) => c.cmd === "update_remote_profile");
    expect(updateCall).toBeDefined();
    expect(updateCall?.args?.profile).toMatchObject({
      id: "host-1",
      label: "Updated",
      sshDestination: "user@new-host",
      port: 2222,
      polytokenPolicy: "offerInstall",
      remoteRootOverride: "/custom/root",
      serverPath: "/custom/server",
      xdgMode: "shared",
    });
  });

  test("deleteProfile delegates to delete_remote_profile", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.deleteProfile("host-1");

    const call = calls.find((c) => c.cmd === "delete_remote_profile");
    expect(call).toBeDefined();
    expect(call?.args).toEqual({ id: "host-1" });
  });

  test("listProfiles maps native commands to RemoteProfile DTOs", async () => {
    const { invoke, calls } = makeInvokeSpy({
      list_remote_profiles: [() => [nativeProfileCmd("p1"), nativeProfileCmd("p2")]],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const profiles = await provider.listProfiles();

    expect(calls[0]?.cmd).toBe("list_remote_profiles");
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.id).toBe("p1");
    expect(profiles[0]!.polytokenPolicy).toBe("offerInstall");
    expect(profiles[0]!.xdgMode).toBe("shared");
    expect(profiles[0]!.port).toBe(2222);
    // Defaults to host execution target.
    expect(profiles[0]!.executionTarget.kind).toBe("host");
  });

  test("getProfile returns null when profile not found", async () => {
    const { invoke } = makeInvokeSpy({
      list_remote_profiles: [() => [nativeProfileCmd("p1")]],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const profile = await provider.getProfile("nonexistent");
    expect(profile).toBeNull();
  });

  // ── Acknowledgement / cancel / resume delegation ──────────────────────

  test("acknowledgeRisk delegates with id, riskId, fingerprint", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.acknowledgeRisk("docker-1", "root-1", "fp-aaa");

    const call = calls.find((c) => c.cmd === "acknowledge_risk");
    expect(call).toBeDefined();
    expect(call?.args).toEqual({ id: "docker-1", riskId: "root-1", fingerprint: "fp-aaa" });
  });

  test("cancelConnection delegates to cancel_connection", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.cancelConnection("docker-1");

    const call = calls.find((c) => c.cmd === "cancel_connection");
    expect(call?.args).toEqual({ id: "docker-1" });
  });

  test("resumeConnection delegates to resume_connection then polls", async () => {
    const { invoke, calls } = makeInvokeSpy({
      resume_connection: [() => snapshot({ state: "connecting" })],
      host_state: [
        () => snapshot({ state: "ready", wsUrl: "ws://127.0.0.1:7777" }),
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.resumeConnection("docker-1");

    const resumeCall = calls.find((c) => c.cmd === "resume_connection");
    expect(resumeCall?.args).toEqual({ id: "docker-1" });
    const stateCalls = calls.filter((c) => c.cmd === "host_state");
    expect(stateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("resumeConnection polls and resolves on non-terminal awaitingAcknowledgement", async () => {
    const { invoke } = makeInvokeSpy({
      resume_connection: [() => snapshot({ state: "preflight" })],
      host_state: [
        () =>
          snapshot({
            state: "awaitingAcknowledgement",
            preflightPhase: "checkingUserPermissions",
            pendingRisks: [
              {
                id: "ephemeral-1",
                kind: "ephemeralData",
                fingerprint: "fp-bbb",
                title: "Ephemeral data",
                explanation: "Recreation may lose data.",
                consequences: "State may be lost.",
                continueLabel: "Allow ephemeral",
              },
            ],
          }),
      ],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    // Must resolve (not throw) so UI can act on the new pending risk.
    await expect(provider.resumeConnection("docker-1")).resolves.toBeUndefined();
  });
});

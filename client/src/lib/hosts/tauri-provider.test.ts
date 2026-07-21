// Tests for the TauriHostProvider — mocks window.__TAURI_INTERNALS__.invoke
// to verify snapshot→descriptor mapping, connect polling, and CRUD delegation.

import { afterEach, describe, expect, test } from "bun:test";
import {
  createTauriHostProvider,
  HostConnectionError,
} from "./tauri-provider.js";
import type { NativeHostDescriptor } from "./types.js";

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

function snapshot(
  overrides: Partial<{
    id: string;
    kind: string;
    label: string;
    subtitle: string;
    state: string;
    wsUrl?: string;
    failureLabel?: string;
    failureAction?: string;
    failureDetail?: string;
  }> = {},
) {
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
        // Second call for the try/catch below.
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

  test("disconnectHost calls disconnect_host with id", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.disconnectHost("remote-1");

    const call = calls.find((c) => c.cmd === "disconnect_host");
    expect(call?.args).toEqual({ id: "remote-1" });
  });

  test("addProfile delegates to add_remote_profile", async () => {
    const { invoke, calls } = makeInvokeSpy({});
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    const profile: NativeHostDescriptor = {
      id: "new-host",
      kind: "remote",
      label: "New Host",
      subtitle: "user@new-host",
      state: "disconnected",
    };
    await provider.addProfile(profile);

    const call = calls.find((c) => c.cmd === "add_remote_profile");
    expect(call).toBeDefined();
    expect(call?.args?.profile).toMatchObject({
      id: "new-host",
      label: "New Host",
      sshDestination: "user@new-host",
    });
  });

  test("updateProfile fetches existing profile and merges fields", async () => {
    const existingProfile = {
      id: "host-1",
      label: "Old Label",
      sshDestination: "user@old-host",
      port: 2222,
      polytokenPolicy: "offer_install",
      remoteRootOverride: "/custom/root",
      serverPath: "/custom/server",
      xdgMode: "shared",
    };
    const { invoke, calls } = makeInvokeSpy({
      list_remote_profiles: [() => [existingProfile]],
    });
    installWindow(invoke);

    const provider = createTauriHostProvider(() => "");
    await provider.updateProfile({
      id: "host-1",
      kind: "remote",
      label: "Updated",
      subtitle: "user@new-host",
      state: "disconnected",
    });

    // Verify list_remote_profiles was called (to fetch existing profile).
    const listCall = calls.find((c) => c.cmd === "list_remote_profiles");
    expect(listCall).toBeDefined();

    // Verify update_remote_profile was called with merged profile:
    // label + sshDestination updated, all other fields preserved.
    const updateCall = calls.find((c) => c.cmd === "update_remote_profile");
    expect(updateCall).toBeDefined();
    expect(updateCall?.args?.profile).toMatchObject({
      id: "host-1",
      label: "Updated",
      sshDestination: "user@new-host",
      port: 2222,
      polytokenPolicy: "offer_install",
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
});

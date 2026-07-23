import { describe, expect, test } from "bun:test";
import { createFakeHostProvider, createSingleHostProvider } from "./provider.js";
import { createDevHostProvider } from "./dev-provider.js";
import type { NativeHostDescriptor } from "./types.js";

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
    const profile = descriptor("remote-1", { kind: "remote" });
    const result = await provider.addProfile(profile);
    expect(result).toEqual(profile);
    // listHosts still returns only the local host.
    const hosts = await provider.listHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].id).toBe("local");
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

  test("addProfile adds a new host", async () => {
    const { provider } = createFakeHostProvider([descriptor("local")]);
    const newProfile = descriptor("remote-2", { kind: "remote" });
    await provider.addProfile(newProfile);
    const hosts = await provider.listHosts();
    expect(hosts.map((h) => h.id)).toContain("remote-2");
  });

  test("deleteProfile removes a host", async () => {
    const { provider } = createFakeHostProvider([
      descriptor("local"),
      descriptor("remote-1", { kind: "remote" }),
    ]);
    await provider.deleteProfile("remote-1");
    const hosts = await provider.listHosts();
    expect(hosts.map((h) => h.id)).not.toContain("remote-1");
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
});

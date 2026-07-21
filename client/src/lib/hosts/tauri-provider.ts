// Tauri host provider: calls the native narrow commands via
// window.__TAURI_INTERNALS__.invoke. This is the desktop-build backing for the
// HostCoordinator — it delegates profile CRUD to the existing Tauri commands
// and drives connect/disconnect through the new host-manager commands
// (ensure_remote_host, host_state, list_hosts, disconnect_host).
//
// The provider does NOT navigate the WebView — the coordinator creates a
// WsClient pointed at the returned loopback wsUrl.

import type { HostProvider } from "./provider.js";
import type { HostConnectionState, NativeHostDescriptor } from "./types.js";

/** The native HostStateSnapshot, mirroring the Rust struct (camelCase fields).
 *  Returned by list_hosts / host_state / ensure_remote_host. */
interface HostStateSnapshot {
  id: string;
  kind: string;
  label: string;
  subtitle: string;
  state: string;
  wsUrl?: string;
  failureLabel?: string;
  failureAction?: string;
  failureDetail?: string;
}

/** A profile as managed by the native CRUD commands (add_remote_profile etc.). */
interface RemoteProfileCommand {
  id: string;
  label: string;
  sshDestination: string;
  port?: number;
  polytokenPolicy: string;
  remoteRootOverride?: string;
  serverPath?: string;
  xdgMode: string;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI_INTERNALS__!.invoke(cmd, args) as Promise<T>;
}

/** Maps a native HostStateSnapshot to a NativeHostDescriptor, overlaying the
 *  local server label + "This computer" subtitle for the local host (the
 *  native layer returns label="" for the local host since it doesn't speak
 *  the WS protocol). */
function snapshotToDescriptor(
  s: HostStateSnapshot,
  localServerLabel: () => string,
): NativeHostDescriptor {
  const isLocal = s.id === "local";
  return {
    id: s.id,
    kind: isLocal ? "local" : (s.kind as "local" | "remote"),
    label: isLocal ? localServerLabel() || "This computer" : s.label,
    subtitle: isLocal ? "This computer" : s.subtitle,
    state: s.state as HostConnectionState,
    wsUrl: s.wsUrl ?? undefined,
    failureLabel: s.failureLabel ?? undefined,
    failureAction: s.failureAction ?? undefined,
    failureDetail: s.failureDetail ?? undefined,
  };
}

/** Poll host_state until the host is ready or failed, with a timeout.
 *  Mirrors the old overlay poller's cadence but runs client-side. */
async function pollHostState(
  id: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<NativeHostDescriptor> {
  const intervalMs = opts.intervalMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await invoke<HostStateSnapshot | null>("host_state", { id });
    if (!snap) throw new Error(`host ${id} not found`);
    if (snap.state === "ready") {
      return snapshotToDescriptor(snap, () => "");
    }
    if (snap.state === "failed") {
      throw new HostConnectionError(
        snap.failureLabel ?? "Connection failed",
        snap.failureAction,
        snap.failureDetail,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`host ${id} timed out waiting for ready`);
}

/** Error thrown when a host connection fails. */
export class HostConnectionError extends Error {
  readonly failureAction?: string;
  readonly failureDetail?: string;
  constructor(label: string, failureAction?: string, failureDetail?: string) {
    super(label);
    this.name = "HostConnectionError";
    this.failureAction = failureAction;
    this.failureDetail = failureDetail;
  }
}

/** The host provider for desktop builds. Calls the Tauri narrow commands.
 *  `localServerLabel` is a callback that reads store.serverLabel (available
 *  after the local server's hello, which the provider is constructed after). */
export function createTauriHostProvider(
  localServerLabel: () => string,
): HostProvider {
  return {
    async listHosts(): Promise<NativeHostDescriptor[]> {
      const snapshots = await invoke<HostStateSnapshot[]>("list_hosts");
      return snapshots.map((s) => snapshotToDescriptor(s, localServerLabel));
    },

    async connectHost(id: string): Promise<void> {
      // Fire ensure_remote_host, then poll host_state until ready or failed.
      await invoke<HostStateSnapshot>("ensure_remote_host", { profileId: id });
      await pollHostState(id);
    },

    async disconnectHost(id: string): Promise<void> {
      await invoke("disconnect_host", { id });
    },

    async addProfile(profile: NativeHostDescriptor): Promise<NativeHostDescriptor> {
      const cmd: RemoteProfileCommand = {
        id: profile.id,
        label: profile.label,
        sshDestination: profile.subtitle,
        port: undefined,
        polytokenPolicy: "require_existing",
        remoteRootOverride: undefined,
        serverPath: undefined,
        xdgMode: "isolated",
      };
      await invoke("add_remote_profile", { profile: cmd });
      return profile;
    },

    async updateProfile(profile: NativeHostDescriptor): Promise<void> {
      // Fetch the existing profile to avoid clobbering fields not carried by
      // NativeHostDescriptor (port, polytokenPolicy, remoteRootOverride,
      // serverPath, xdgMode). Only label and sshDestination are updated.
      const existing = await invoke<RemoteProfileCommand[]>(
        "list_remote_profiles",
      );
      const current = existing.find((p) => p.id === profile.id);
      if (!current) {
        throw new Error(`no profile with id ${profile.id}`);
      }
      const cmd: RemoteProfileCommand = {
        ...current,
        label: profile.label,
        sshDestination: profile.subtitle,
      };
      await invoke("update_remote_profile", { profile: cmd });
    },

    async deleteProfile(id: string): Promise<void> {
      await invoke("delete_remote_profile", { id });
    },
  };
}

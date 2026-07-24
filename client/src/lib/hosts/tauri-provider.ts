// Tauri host provider: calls the native narrow commands via
// window.__TAURI_INTERNALS__.invoke. This is the desktop-build backing for the
// HostCoordinator — it delegates profile CRUD to the existing Tauri commands
// and drives connect/disconnect through the host-manager commands
// (ensure_remote_host, host_state, list_hosts, disconnect_host).
//
// The provider does NOT navigate the WebView — the coordinator creates a
// WsClient pointed at the returned loopback wsUrl.

import type { HostProvider } from "./provider.js";
import type {
  ContainerInspection,
  HostConnectionState,
  NativeHostDescriptor,
  PendingRisk,
  PreflightPhase,
  RemoteProfile,
  TestSshResult,
} from "./types.js";

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
  /** Present only during preflight/awaitingAcknowledgement. */
  preflightPhase?: string;
  /** Present only for awaitingAcknowledgement. */
  pendingRisks?: PendingRiskDto[];
  /** Redacted SSH context host, present for Docker targets so the subtitle
   *  can be built as `<container> via <redacted host>` without reconstructing
   *  from the server hello. */
  redactedSshHost?: string;
  /** The configured container name, present for Docker targets. */
  containerName?: string;
}

/** A pending risk as returned by the native layer. Mirrors the Rust DTO. */
interface PendingRiskDto {
  id: string;
  kind: string;
  fingerprint: string;
  title: string;
  explanation: string;
  consequences: string;
  continueLabel: string;
}

/** A profile as managed by the native CRUD commands (add_remote_profile etc.).
 *  Mirrors the Rust `RemoteProfile` serde (camelCase). */
interface RemoteProfileCommand {
  id: string;
  label: string;
  sshDestination: string;
  port?: number;
  polytokenPolicy: string;
  remoteRootOverride?: string;
  serverPath?: string;
  xdgMode: string;
  executionTarget?: RemoteProfile["executionTarget"];
  riskAcknowledgements?: RemoteProfile["riskAcknowledgements"];
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI_INTERNALS__!.invoke(cmd, args) as Promise<T>;
}

/** Non-terminal states: polling resolves with the descriptor instead of
 *  throwing, so the UI can render pending risks / preflight progress and act. */
const NON_TERMINAL_POLL_STATES = new Set([
  "preflight",
  "awaitingAcknowledgement",
]);

/** Maps a native HostStateSnapshot to a NativeHostDescriptor, overlaying the
 *  local server label + "This computer" subtitle for the local host (the
 *  native layer returns label="" for the local host since it doesn't speak
 *  the WS protocol). For Docker targets, builds the subtitle as
 *  `<container> via <redacted ssh host>` using the native snapshot, not the
 *  server hello. */
function snapshotToDescriptor(
  s: HostStateSnapshot,
  localServerLabel: () => string,
): NativeHostDescriptor {
  const isLocal = s.id === "local";

  // For Docker targets, build a redacted subtitle from the snapshot's
  // container name + redacted SSH host. This is the only place the subtitle
  // is constructed for a Docker host — never from the hello.
  let subtitle = isLocal ? "This computer" : s.subtitle;
  if (!isLocal && s.containerName && s.redactedSshHost) {
    subtitle = `${s.containerName} via ${s.redactedSshHost}`;
  }

  const pendingRisks = s.pendingRisks?.map(dtoToPendingRisk);
  const preflightPhase = s.preflightPhase as PreflightPhase | undefined;

  return {
    id: s.id,
    kind: isLocal ? "local" : (s.kind as "local" | "remote"),
    label: isLocal ? localServerLabel() || "This computer" : s.label,
    subtitle,
    state: s.state as HostConnectionState,
    wsUrl: s.wsUrl ?? undefined,
    failureLabel: s.failureLabel ?? undefined,
    failureAction: s.failureAction ?? undefined,
    failureDetail: s.failureDetail ?? undefined,
    preflightPhase: preflightPhase ?? undefined,
    pendingRisks: pendingRisks,
    isDockerTarget: Boolean(s.containerName),
  };
}

function dtoToPendingRisk(dto: PendingRiskDto): PendingRisk {
  return {
    id: dto.id,
    kind: dto.kind as PendingRisk["kind"],
    fingerprint: dto.fingerprint,
    title: dto.title,
    explanation: dto.explanation,
    consequences: dto.consequences,
    continueLabel: dto.continueLabel,
  };
}

/** Poll host_state until the host reaches a terminal-ish state.
 *
 *  - `ready` → resolves with the descriptor.
 *  - `failed` → throws HostConnectionError.
 *  - `preflight` / `awaitingAcknowledgement` → resolves (does NOT throw) so
 *    the UI can render pending risks / preflight progress and offer
 *    acknowledge / cancel / resume.
 *  - `disconnected` → throws (the connection was cancelled or dropped).
 *
 *  This mirrors the old overlay poller's cadence but runs client-side. */
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
    if (snap.state === "disconnected") {
      throw new HostConnectionError("Connection cancelled");
    }
    if (NON_TERMINAL_POLL_STATES.has(snap.state)) {
      // Return the descriptor so the UI can act on pending risks / preflight.
      return snapshotToDescriptor(snap, () => "");
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
    supportsMultiHost() {
      return true;
    },
    async listHosts(): Promise<NativeHostDescriptor[]> {
      const snapshots = await invoke<HostStateSnapshot[]>("list_hosts");
      return snapshots.map((s) => snapshotToDescriptor(s, localServerLabel));
    },

    async connectHost(id: string): Promise<void> {
      // Fire ensure_remote_host, then poll host_state until ready, failed, or
      // a non-terminal preflight/acknowledgement state is reached. Polling
      // resolves (does not throw) for non-terminal states so the UI can act.
      await invoke<HostStateSnapshot>("ensure_remote_host", { profileId: id });
      await pollHostState(id);
    },

    async disconnectHost(id: string): Promise<void> {
      await invoke("disconnect_host", { id });
    },

    async listProfiles(): Promise<RemoteProfile[]> {
      const cmds = await invoke<RemoteProfileCommand[]>(
        "list_remote_profiles",
      );
      return cmds.map(cmdToProfile);
    },

    async getProfile(id: string): Promise<RemoteProfile | null> {
      const all = await invoke<RemoteProfileCommand[]>(
        "list_remote_profiles",
      );
      const cmd = all.find((p) => p.id === id);
      return cmd ? cmdToProfile(cmd) : null;
    },

    async addProfile(profile: RemoteProfile): Promise<RemoteProfile> {
      const cmd = profileToCmd(profile);
      const saved = await invoke<RemoteProfileCommand>("add_remote_profile", {
        profile: cmd,
      });
      return cmdToProfile(saved);
    },

    async updateProfile(profile: RemoteProfile): Promise<void> {
      const cmd = profileToCmd(profile);
      await invoke("update_remote_profile", { profile: cmd });
    },

    async deleteProfile(id: string): Promise<void> {
      await invoke("delete_remote_profile", { id });
    },

    async acknowledgeRisk(
      id: string,
      riskId: string,
      fingerprint: string,
    ): Promise<void> {
      await invoke("acknowledge_risk", { id, riskId, fingerprint });
    },

    async cancelConnection(id: string): Promise<void> {
      await invoke("cancel_connection", { id });
    },

    async resumeConnection(id: string): Promise<void> {
      await invoke("resume_connection", { id });
      // After resuming, poll again for ready / failed / next non-terminal state.
      await pollHostState(id);
    },

    supportsContainerTargets() {
      return true;
    },

    async testSshAndListContainers(
      sshDestination: string,
      port?: number,
    ): Promise<TestSshResult> {
      try {
        return await invoke<TestSshResult>("test_ssh_and_list_containers", {
          sshDestination,
          port: port ?? 22,
        });
      } catch {
        // Gap (a) degradation: the command is not available. The UI shows the
        // degradation hint and the Docker option is effectively unusable.
        throw new Error("Container commands are not available in this build");
      }
    },

    async inspectContainer(
      sshDestination: string,
      port: number | undefined,
      containerName: string,
    ): Promise<ContainerInspection> {
      try {
        return await invoke<ContainerInspection>("inspect_container", {
          sshDestination,
          port: port ?? 22,
          containerName,
        });
      } catch {
        // Gap (b) degradation: the Customize target disclosure shows an
        // inspection-unavailable state.
        throw new Error("Container inspection is not available in this build");
      }
    },
  };
}

/** Convert a RemoteProfile editor DTO to the native command shape. */
function profileToCmd(profile: RemoteProfile): RemoteProfileCommand {
  return {
    id: profile.id,
    label: profile.label,
    sshDestination: profile.sshDestination,
    port: profile.port,
    polytokenPolicy: profile.polytokenPolicy,
    remoteRootOverride: profile.remoteRootOverride,
    serverPath: profile.serverPath,
    xdgMode: profile.xdgMode,
    executionTarget: profile.executionTarget,
    riskAcknowledgements: profile.riskAcknowledgements,
  };
}

/** Convert a native command back to the RemoteProfile editor DTO. Docker
 *  execution-target fields are not yet carried by the native CRUD command
 *  (Phase 1 native work is in scope for the Rust layer); the client DTO
 *  defaults to host mode when the native command carries no target fields.
 *  Acknowledgements are populated from the profile store when the native
 *  layer exposes them. */
function cmdToProfile(cmd: RemoteProfileCommand): RemoteProfile {
  return {
    id: cmd.id,
    label: cmd.label,
    sshDestination: cmd.sshDestination,
    port: cmd.port,
    polytokenPolicy: cmd.polytokenPolicy as RemoteProfile["polytokenPolicy"],
    remoteRootOverride: cmd.remoteRootOverride,
    serverPath: cmd.serverPath,
    xdgMode: cmd.xdgMode as RemoteProfile["xdgMode"],
    executionTarget: cmd.executionTarget ?? { kind: "host" },
    riskAcknowledgements: cmd.riskAcknowledgements ?? {},
  };
}

// Pure host descriptor and activity types for multi-computer connections.
// No Svelte, no DOM — these are serializable types shared between the host
// coordinator, providers, and the UI layer (stages 4+).

/** Whether a host is the local machine or a remote computer. */
export type HostKind = "local" | "remote";

/**
 * The connection lifecycle of a host computer, surfaced to the UI.
 *
 * The preflight/acknowledgement states are non-terminal: they pause the
 * connection attempt until the UI acts (acknowledges a risk or cancels).
 * Polling {@link HostProvider.connectHost} MUST return a descriptor in one of
 * these states rather than throwing, so the UI can render the risk and offer
 * a continue/cancel action.
 */
export type HostConnectionState =
  | "disconnected"
  | "testingSsh"
  | "preflight"
  | "awaitingAcknowledgement"
  | "connecting"
  | "provisioning"
  | "starting"
  | "ready"
  | "reconnecting"
  | "failed";

/**
 * A coarse phase during the Docker-target preflight, surfaced so the UI can
 * show progress without encoding every label as a top-level lifecycle state.
 * Present on {@link NativeHostDescriptor.preflightPhase} only while the host
 * is in `preflight` or `awaitingAcknowledgement`; absent otherwise.
 */
export type PreflightPhase =
  | "checkingDockerAccess"
  | "locatingContainer"
  | "inspectingIdentity"
  | "checkingUserPermissions"
  | "checkingPersistence";

/** Whether execution happens on the SSH host or inside a Docker container. */
export type ExecutionTargetKind = "host" | "docker";

/**
 * The kind of risk that requires an explicit acknowledgement before a Docker
 * target connection may proceed. Each pending risk carries a fingerprint of
 * the canonical facts it covers; an acknowledgement is only valid while the
 * fingerprint matches the current resolved target.
 */
export type RiskKind = "rootExecution" | "ephemeralData";

/**
 * A pending risk surfaced during preflight that blocks progression until the
 * user explicitly acknowledges it (or cancels). Mirrors the native DTO so it
 * round-trips through the Tauri command layer without flattening.
 *
 * Warning data MUST live here, never in {@link NativeHostDescriptor.failureDetail}
 * or {@link HostConnectionError}. A pending risk is not a failure.
 */
export interface PendingRisk {
  /** Stable id for this risk within the current connection attempt. */
  id: string;
  /** What kind of risk this is. */
  kind: RiskKind;
  /**
   * SHA-256 hex of the canonical risk facts (lowercase, 64 chars). The native
   * layer validates an acknowledgement against a fresh inspection before
   * persisting it; the client treats this as an opaque equality token.
   */
  fingerprint: string;
  /** Short human-readable title (e.g. "Running as root"). */
  title: string;
  /** Explanation of the risk and why it applies now. */
  explanation: string;
  /** What can go wrong if the user proceeds (e.g. data loss on recreation). */
  consequences: string;
  /** Label for the continue/acknowledge action (e.g. "Allow root"). */
  continueLabel: string;
}

/**
 * A host computer the client can connect to. Serializable so it can be
 * persisted (remote profiles) and exchanged with the native layer.
 *
 * This is a *summary* — it carries the fields the host switcher / coordinator
 * needs (label, state, wsUrl, redacted failure). It is NOT the editor DTO:
 * advanced Docker fields, polytoken policy, and acknowledgement state live on
 * {@link RemoteProfile}, which the provider CRUD methods use.
 */
export interface NativeHostDescriptor {
  /** "local" for the local machine, or the RemoteProfile.id for a remote. */
  id: string;
  kind: HostKind;
  label: string;
  subtitle: string;
  state: HostConnectionState;
  /** The WebSocket URL to connect to. Loopback only; present when the host
   *  is usable (ready/starting/reconnecting). Absent for disconnected/failed. */
  wsUrl?: string;
  /** Short human-readable failure reason (e.g. "SSH unreachable"). */
  failureLabel?: string;
  /** Action label for the failure recovery affordance (e.g. "Retry"). */
  failureAction?: string;
  /** Redacted diagnostic detail for advanced troubleshooting. */
  failureDetail?: string;
  /** Present only during preflight/awaitingAcknowledgement; absent otherwise. */
  preflightPhase?: PreflightPhase;
  /** Present only for awaitingAcknowledgement; the risks the UI must act on. */
  pendingRisks?: PendingRisk[];
}

/** Aggregate activity for a host, derived from its sessionStatus messages.
 *  This is the per-host summary the coordinator tracks for inactive hosts
 *  without folding their transcript events. */
export interface HostActivity {
  running: boolean;
  unseen: boolean;
  waiting: boolean;
  failed: boolean;
}

/** A host summary combining the descriptor, activity, and baseline status.
 *  Used by the coordinator to expose host state to the UI (stages 4+). */
export interface HostSummary {
  descriptor: NativeHostDescriptor;
  activity: HostActivity;
  /** True once the first sessionStatus has established a baseline. */
  baselined: boolean;
  /** Whether this is the coordinator's selected host. */
  selected: boolean;
  /** Authoritative visual/activity state for compact host surfaces. */
  indicator: import("./activity.js").HostIndicator;
  /** Localized, accessible connection/activity description. */
  statusText: string;
}

// ── RemoteProfile editor DTO ──────────────────────────────────────────────
//
// A dedicated serializable profile used by the host-provider CRUD methods
// (addProfile / updateProfile) and the editor UI. It is deliberately NOT a
// NativeHostDescriptor: the descriptor is a connection *summary* (label,
// state, wsUrl, redacted failure), while the profile is the full editor
// contract (SSH destination, polytoken policy, Docker target, acknowledgements).
//
// Field names mirror the native Rust `RemoteProfile` serde (camelCase) so the
// DTO round-trips through the Tauri command layer without translation.

/** Policy for the remote polytoken runtime install. Mirrors the Rust enum. */
export type PolytokenPolicy = "requireExisting" | "offerInstall";

/** XDG isolation mode for a Pantoken-managed polytoken. Mirrors the Rust enum. */
export type XdgMode = "isolated" | "shared";

/**
 * Tagged execution target. `host` (the serde default for all existing profile
 * JSON) runs on the SSH host. `docker` runs inside a pinned, already-running
 * Docker container reached via the SSH host's Docker CLI.
 */
export interface HostExecutionTarget {
  kind: "host";
}

/**
 * Docker execution target. Resolves an exact container *name* (never a
 * transient ID) on the SSH host, pins the full immutable container ID for a
 * single connection attempt, and runs all target operations inside it.
 *
 * The container ID is resolution metadata for one attempt, not durable
 * identity — it is never persisted as the profile's identity.
 */
export interface DockerExecutionTarget {
  kind: "dockerContainer";
  /** Exact container name. Pantoken never mutates container lifecycle. */
  containerName: string;
  /** Explicitly selected execution user (name or numeric uid[:gid]). */
  user: string;
  /** Optional absolute in-container working directory. */
  workdir?: string;
  /**
   * Absolute in-container Pantoken root. Required for Docker mode because
   * `~` expansion across `docker exec` is ambiguous; the UI/preview must
   * confirm a resolved absolute root before persistence.
   */
  pantokenRoot: string;
}

/** Discriminated union of execution targets. */
export type ExecutionTargetProfile = HostExecutionTarget | DockerExecutionTarget;

/**
 * An acknowledgement of a single pending risk, persisted as a hash so no raw
 * bind source paths or verbose inspect records are stored. The fingerprint
 * MUST match the current resolved target's risk fingerprint; if the container
 * is replaced, effective identity changes, or mount backing changes, the
 * acknowledgement is invalidated and the risk re-surfaces.
 *
 * Schema version lets the canonicalization evolve without silently treating
 * a stale acknowledgement as accepted.
 */
export interface RiskAcknowledgements {
  /** Lowercase SHA-256 hex for the current root-execution facts. */
  rootFingerprint?: string;
  /** Lowercase SHA-256 hex for the current persistence facts. */
  ephemeralFingerprint?: string;
}

/**
 * The full remote-profile editor DTO. Used by {@link HostProvider.addProfile}
 * and {@link HostProvider.updateProfile}. Existing host-only profile JSON (with
 * no execution-target fields) deserializes as host mode — `executionTarget`
 * defaults to `{ kind: "host" }`.
 *
 * No secret fields: the struct carries no password, key, token, or Docker
 * socket path. Credentials live in the system SSH agent / keychain /
 * `~/.ssh/config`.
 */
export interface RemoteProfile {
  /** Stable identity (UUID or slug). Not displayed. */
  id: string;
  /** Display name ("Mac Mini", "Build Server"). */
  label: string;
  /** `user@host` or an SSH config alias. */
  sshDestination: string;
  /** SSH port; defaults to 22 when absent. */
  port?: number;
  /** Whether the remote runtime must already exist, or desktop may offer install. */
  polytokenPolicy: PolytokenPolicy;
  /** Override for the remote runtime's data root. */
  remoteRootOverride?: string;
  /** Override for the remote `pantoken-server` binary path. */
  serverPath?: string;
  /** XDG isolation mode for a Pantoken-managed polytoken. */
  xdgMode: XdgMode;
  /** Execution target. Defaults to host mode for existing profiles. */
  executionTarget: ExecutionTargetProfile;
  /**
   * Acknowledged risk fingerprints, keyed by risk kind. An entry is only valid
   * while its fingerprint matches the current resolved target. Absent for
   * host-mode profiles (no risks to acknowledge).
   */
  riskAcknowledgements: RiskAcknowledgements;
}

/**
 * Build a host-mode RemoteProfile from the legacy NativeHostDescriptor shape.
 * Used by providers that previously stored descriptors as profiles. Advanced
 * fields default to their documented values, matching the Rust defaults.
 */
export function hostProfileFromDescriptor(
  descriptor: NativeHostDescriptor,
): RemoteProfile {
  return {
    id: descriptor.id,
    label: descriptor.label,
    sshDestination: descriptor.subtitle,
    polytokenPolicy: "requireExisting",
    xdgMode: "isolated",
    executionTarget: { kind: "host" },
    riskAcknowledgements: {},
  };
}

/**
 * A redacted summary of an SSH context for display. Used to build Docker
 * subtitles (`<container> via <redacted ssh context>`) without reconstructing
 * from the server hello. `host` is a bare host or alias, never the full
 * `user@host` credential-bearing string.
 */
export interface RedactedSshContext {
  /** Bare host or SSH-config alias (no user@). */
  host: string;
}

/**
 * Redact a full SSH destination (`user@host:port` / alias) to a bare host or
 * alias suitable for a subtitle. Strips the user and port. If the destination
 * is an alias with no `@`, it is returned as-is.
 */
export function redactSshDestination(sshDestination: string): RedactedSshContext {
  const trimmed = sshDestination.trim();
  // Strip an optional `user@` prefix.
  const atIdx = trimmed.lastIndexOf("@");
  let host = atIdx >= 0 ? trimmed.slice(atIdx + 1) : trimmed;
  // Strip an optional `:port` suffix.
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx >= 0) {
    const candidate = host.slice(colonIdx + 1);
    if (/^\d+$/.test(candidate)) {
      host = host.slice(0, colonIdx);
    }
  }
  return { host: host || trimmed };
}

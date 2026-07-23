// Pure host descriptor and activity types for multi-computer connections.
// No Svelte, no DOM — these are serializable types shared between the host
// coordinator, providers, and the UI layer (stages 4+).

/** Whether a host is the local machine or a remote computer. */
export type HostKind = "local" | "remote";

/** The connection lifecycle of a host computer, surfaced to the UI. */
export type HostConnectionState =
  | "disconnected"
  | "testingSsh"
  | "connecting"
  | "provisioning"
  | "starting"
  | "ready"
  | "reconnecting"
  | "failed";

/** A host computer the client can connect to. Serializable so it can be
 *  persisted (remote profiles) and exchanged with the native layer. */
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

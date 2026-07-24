// Host provider interface: the seam between the coordinator and the platform
// that manages host connections (Tauri in desktop, single-host in browser/e2e,
// fake in tests).
//
// No Svelte — this is a pure interface + factory functions.

import type {
  ContainerInspection,
  ContainerSummary,
  HostActivity,
  HostConnectionState,
  NativeHostDescriptor,
  RemoteProfile,
  TestSshResult,
} from "./types.js";

/** The provider the coordinator depends on. In desktop builds this is backed
 *  by Tauri (stage 4); in browser/e2e builds it's a SingleHostProvider; in
 *  tests it's a FakeHostProvider. */
export interface HostProvider {
  /** Whether this provider exposes multiple selectable computers. */
  supportsMultiHost(): boolean;
  /** List local + saved remote computer descriptors (summaries). */
  listHosts(): Promise<NativeHostDescriptor[]>;
  /** Ensure/connect one remote computer; poll its state and bridge URL.
   *
   *  This MUST NOT throw when the host enters a non-terminal preflight or
   *  awaiting-acknowledgement state. Instead it resolves (returning the
   *  descriptor with `state` set accordingly) so the UI can render pending
   *  risks and offer acknowledge / cancel / resume actions. It throws only on
   *  hard failures (SSH unreachable, provisioning failed, etc.) or a cancel. */
  connectHost(id: string): Promise<void>;
  /** Disconnect one remote computer. */
  disconnectHost(id: string): Promise<void>;
  /** List saved remote profiles (the full editor DTO, not summaries). */
  listProfiles(): Promise<RemoteProfile[]>;
  /** Get one saved remote profile by id. */
  getProfile(id: string): Promise<RemoteProfile | null>;
  /** Add a remote profile. Returns the persisted profile (with any
   *  native-assigned fields). */
  addProfile(profile: RemoteProfile): Promise<RemoteProfile>;
  /** Update an existing remote profile. Connection-affecting Docker changes
   *  mark reconnection required but do not silently retarget active work. */
  updateProfile(profile: RemoteProfile): Promise<void>;
  /** Remove a remote profile by id. */
  deleteProfile(id: string): Promise<void>;
  /**
   * Acknowledge one exact pending risk for a host, validating the fingerprint
   * natively against a fresh inspection before persisting it. Resolves when
   * the acknowledgement is accepted; the caller then resumes the connection.
   * Throws if the risk id/fingerprint no longer matches (the target changed).
   */
  acknowledgeRisk(
    id: string,
    riskId: string,
    fingerprint: string,
  ): Promise<void>;
  /** Cancel a pending preflight/acknowledgement for a host. */
  cancelConnection(id: string): Promise<void>;
  /** Resume a connection that was paused on preflight/acknowledgement. */
  resumeConnection(id: string): Promise<void>;

  // ── Docker container target methods (gap a/b/e) ──────────────────────────

  /** Whether this provider can test SSH and discover/inspect Docker
   *  containers. Returns true for the Tauri and dev providers; false for
   *  the browser single-host provider. The UI uses this to disable the
   *  Docker container option in the setup dialog's segmented control. */
  supportsContainerTargets(): boolean;
  /** Test the SSH destination and list running containers. Called before
   *  saving a profile (gap a). Throws if the command is unavailable on the
   *  current platform. */
  testSshAndListContainers(
    sshDestination: string,
    port?: number,
  ): Promise<TestSshResult>;
  /** Inspect a single container to get resolved user/UID, home, mounts, and
   *  the Pantoken root suggestion (gap b). Called from the Customize target
   *  disclosure. Throws if the command is unavailable. */
  inspectContainer(
    sshDestination: string,
    port: number | undefined,
    containerName: string,
  ): Promise<ContainerInspection>;
}

/** A provider for browser/e2e builds that exposes one current-server descriptor
 *  and no remote management. It never invokes Tauri — the browser connects to
 *  the same WS server that serves the page. */
export function createSingleHostProvider(wsUrl: string): HostProvider {
  const localDescriptor: NativeHostDescriptor = {
    id: "local",
    kind: "local",
    label: "This computer",
    subtitle: "",
    state: "ready",
    wsUrl,
  };

  return {
    supportsMultiHost() {
      return false;
    },
    async listHosts() {
      return [localDescriptor];
    },
    async connectHost() {
      // No-op: the local host is always connected in browser mode.
    },
    async disconnectHost() {
      // No-op: cannot disconnect the local host.
    },
    async listProfiles() {
      // No remote management in single-host mode.
      return [];
    },
    async getProfile() {
      return null;
    },
    async addProfile(profile) {
      // No remote management in single-host mode — return as-is.
      return profile;
    },
    async updateProfile() {
      // No-op.
    },
    async deleteProfile() {
      // No-op.
    },
    async acknowledgeRisk() {
      // No-op: no Docker targets in single-host mode.
    },
    async cancelConnection() {
      // No-op.
    },
    async resumeConnection() {
      // No-op.
    },
    supportsContainerTargets() {
      return false;
    },
    async testSshAndListContainers() {
      throw new Error("Docker targets require the Pantoken desktop app");
    },
    async inspectContainer() {
      throw new Error("Docker targets require the Pantoken desktop app");
    },
  };
}

/** A provider for tests that can inject multiple logical host descriptors
 *  backed by mock WebSocket URLs, plus hooks to drive ready/running/unseen/
 *  waiting/reconnecting/failed states.
 *
 *  The fake also supports deterministic Docker-target scenarios: it stores
 *  profiles by id and can be driven through preflight phases and pending
 *  risks so the UI can be rendered and tested without real SSH or Docker. */
export interface FakeHostController {
  driveState: (id: string, state: HostConnectionState) => void;
  driveActivity: (id: string, activity: HostActivity) => void;
  /** Get the in-memory profile for a host id (or null). */
  getProfile: (id: string) => RemoteProfile | null;
  /** Set the pending risks surfaced for a host during awaitingAcknowledgement. */
  setPendingRisks: (id: string, risks: NativeHostDescriptor["pendingRisks"]) => void;
  /** Set the preflight phase surfaced for a host during preflight. */
  setPreflightPhase: (id: string, phase: NativeHostDescriptor["preflightPhase"]) => void;
}

export function createFakeHostProvider(
  hosts: NativeHostDescriptor[],
  initialProfiles?: RemoteProfile[],
): {
  provider: HostProvider;
  driveState: (id: string, state: HostConnectionState) => void;
  driveActivity: (id: string, activity: HostActivity) => void;
  getProfile: (id: string) => RemoteProfile | null;
  setPendingRisks: (id: string, risks: NativeHostDescriptor["pendingRisks"]) => void;
  setPreflightPhase: (id: string, phase: NativeHostDescriptor["preflightPhase"]) => void;
  setContainerPicker: (id: string, containers: ContainerSummary[]) => void;
  setInspection: (containerName: string, inspection: ContainerInspection) => void;
} {
  // Clone the initial descriptors so the test can't mutate them.
  let hostMap = new Map<string, NativeHostDescriptor>(
    hosts.map((h) => [h.id, { ...h }]),
  );
  // Profiles are stored separately from descriptors: a descriptor is a summary,
  // a profile is the full editor DTO.
  let profileMap = new Map<string, RemoteProfile>(
    (initialProfiles ?? []).map((p) => [p.id, structuredClone(p)]),
  );
  // Acknowledgements recorded via acknowledgeRisk, for assertion.
  const acknowledged = new Map<string, { riskId: string; fingerprint: string }>();
  // Container picker data injected by tests (setContainerPicker).
  let containerPickers = new Map<string, ContainerSummary[]>();
  // Container inspection data injected by tests (setInspection).
  let inspectionMap = new Map<string, ContainerInspection>();

  const provider: HostProvider = {
    supportsMultiHost() {
      return hosts.length > 1;
    },
    async listHosts() {
      return [...hostMap.values()];
    },
    async connectHost(id) {
      // In the fake, connectHost resolves (does not throw) for non-terminal
      // preflight/awaitingAcknowledgement states, mirroring the real contract.
      // It only advances to ready if the current state is a terminal-ish or
      // connecting state. Awaiting-acknowledgement leaves the state as-is.
      const h = hostMap.get(id);
      if (h) {
        if (
          h.state === "disconnected" ||
          h.state === "testingSsh" ||
          h.state === "connecting" ||
          h.state === "reconnecting"
        ) {
          hostMap.set(id, { ...h, state: "ready" });
        }
        // preflight / awaitingAcknowledgement / provisioning / starting /
        // ready / failed are left as-is so tests can assert them.
      }
    },
    async disconnectHost(id) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, { ...h, state: "disconnected" });
      }
    },
    async listProfiles() {
      return [...profileMap.values()].map((p) => structuredClone(p));
    },
    async getProfile(id) {
      const p = profileMap.get(id);
      return p ? structuredClone(p) : null;
    },
    async addProfile(profile) {
      const stored = structuredClone(profile);
      profileMap.set(profile.id, stored);
      return structuredClone(stored);
    },
    async updateProfile(profile) {
      const stored = structuredClone(profile);
      profileMap.set(profile.id, stored);
    },
    async deleteProfile(id) {
      profileMap.delete(id);
      hostMap.delete(id);
    },
    async acknowledgeRisk(id, riskId, fingerprint) {
      const h = hostMap.get(id);
      const risks = h?.pendingRisks;
      if (!risks || risks.length === 0) {
        throw new Error(`no pending risks for host ${id}`);
      }
      const risk = risks.find((r) => r.id === riskId);
      if (!risk) {
        throw new Error(`no pending risk ${riskId} for host ${id}`);
      }
      if (risk.fingerprint !== fingerprint) {
        throw new Error(
          `fingerprint mismatch for risk ${riskId}: target changed`,
        );
      }
      acknowledged.set(id, { riskId, fingerprint });
    },
    async cancelConnection(id) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, {
          ...h,
          state: "disconnected",
          pendingRisks: undefined,
          preflightPhase: undefined,
        });
      }
    },
    async resumeConnection(id) {
      const h = hostMap.get(id);
      if (h) {
        // Resume from awaitingAcknowledgement → ready (risks acknowledged).
        if (h.state === "awaitingAcknowledgement" || h.state === "preflight") {
          hostMap.set(id, {
            ...h,
            state: "ready",
            pendingRisks: undefined,
            preflightPhase: undefined,
          });
        }
      }
    },
    supportsContainerTargets() {
      return true;
    },
    async testSshAndListContainers(
      _sshDestination: string,
      _port?: number,
    ): Promise<TestSshResult> {
      const containers =
        containerPickers.get("__default__") ?? defaultContainerFixtures;
      return {
        sshOk: true,
        dockerPermission: "granted",
        containers: structuredClone(containers),
      };
    },
    async inspectContainer(
      _sshDestination: string,
      _port: number | undefined,
      containerName: string,
    ): Promise<ContainerInspection> {
      const cached = inspectionMap.get(containerName);
      if (cached) return structuredClone(cached);
      return structuredClone(defaultInspection(containerName));
    },
  };

  return {
    provider,
    driveState(id, state) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, { ...h, state });
      }
    },
    driveActivity(_id, _activity) {
      // Activity is derived from sessionStatus messages by the coordinator,
      // not from the provider. This hook exists for tests that want to verify
      // the provider's driveState interface; the coordinator tracks activity
      // independently via applySessionStatus.
      // No-op: activity tracking is the coordinator's responsibility.
    },
    getProfile(id) {
      const p = profileMap.get(id);
      return p ? structuredClone(p) : null;
    },
    setPendingRisks(id, risks) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, { ...h, pendingRisks: risks ?? undefined });
      }
    },
    setPreflightPhase(id, phase) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, { ...h, preflightPhase: phase ?? undefined });
      }
    },
    setContainerPicker(_id: string, containers: ContainerSummary[]) {
      containerPickers.set("__default__", structuredClone(containers));
    },
    setInspection(containerName: string, inspection: ContainerInspection) {
      inspectionMap.set(containerName, structuredClone(inspection));
    },
  };
}

// ── Default fixtures for the fake provider ──────────────────────────────────

const defaultContainerFixtures: ContainerSummary[] = [
  {
    name: "work-api-dev",
    image: "node:20-alpine",
    state: "running",
    configuredUser: "dev",
    composeProject: "work-api",
    composeService: "api",
  },
  {
    name: "postgres-dev",
    image: "postgres:16",
    state: "running",
    configuredUser: "",
  },
  {
    name: "redis-cache",
    image: "redis:7-alpine",
    state: "running",
    configuredUser: "",
  },
];

function defaultInspection(containerName: string): ContainerInspection {
  return {
    name: containerName,
    containerId: `id-${containerName}`,
    image: "node:20-alpine",
    running: true,
    configuredUser: "dev",
    resolvedUser: "dev",
    resolvedUid: 1000,
    resolvedGid: 1000,
    resolvedHome: "/home/dev",
    os: "linux",
    arch: "arm64",
    pantokenRootSuggestion: "/home/dev/.local/share/pantoken",
    mounts: [
      {
        type: "volume",
        name: "pantoken-data",
        destination: "/home/dev/.local/share/pantoken",
        readOnly: false,
      },
    ],
  };
}

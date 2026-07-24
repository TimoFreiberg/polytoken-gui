import type { ServerMessage, SessionAttention } from "@pantoken/protocol";
import type {
  ContainerInspection,
  ContainerSummary,
  HostActivity,
  HostConnectionState,
  NativeHostDescriptor,
  PendingRisk,
  PreflightPhase,
  RemoteProfile,
  TestSshResult,
} from "./types.js";
import type { HostProvider } from "./provider.js";

export interface DevHostControls {
  setState(id: string, state: HostConnectionState): void;
  setActivity(id: string, activity: HostActivity): void;
  emit(id: string, message: ServerMessage): void;
  setMessageSink(sink: ((id: string, message: ServerMessage) => void) | null): void;
  // ── Docker-state hooks ──────────────────────────────────────────────────
  /** Set the pending risks surfaced for a host during awaitingAcknowledgement. */
  setPendingRisks(id: string, risks: PendingRisk[]): void;
  /** Set the preflight phase surfaced for a host during preflight. */
  setPreflightPhase(id: string, phase: PreflightPhase): void;
  /** Set the containers returned by testSshAndListContainers. */
  setContainerPicker(id: string, containers: ContainerSummary[]): void;
  /** Drive the provisioning phase (1-4) for a host. */
  driveProvisioningPhase(id: string, phase: number): void;
  /** Simulate a container replacement (new container ID under the same name). */
  driveReplacement(id: string): void;
  /** Get the inspection data for a container name (or null). */
  getInspection(containerName: string): ContainerInspection | null;
  /** Set the inspection data for a container name. */
  setInspection(containerName: string, inspection: ContainerInspection): void;
}

export type DevHostProvider = HostProvider & DevHostControls;

/** Default container fixtures for the dev provider. */
const DEV_CONTAINERS: ContainerSummary[] = [
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

/** Default inspection fixture for the dev provider. */
function defaultInspection(containerName: string): ContainerInspection {
  return {
    name: containerName,
    containerId: `dev-id-${containerName}-${Date.now()}`,
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

/** Deterministic multi-host provider used only by ?dev previews/e2e. */
export function createDevHostProvider(wsUrl: string): DevHostProvider {
  const hostMap = new Map<string, NativeHostDescriptor>([
    ["local", {
      id: "local", kind: "local", label: "Dev computer", subtitle: "This computer",
      state: "ready", wsUrl,
    }],
    ["dev-remote", {
      id: "dev-remote", kind: "remote", label: "Dev remote", subtitle: "dev@example.test",
      state: "disconnected",
    }],
  ]);
  let sink: ((id: string, message: ServerMessage) => void) | null = null;
  const profileMap = new Map<string, RemoteProfile>();
  // Docker state maps.
  const pendingRisksMap = new Map<string, PendingRisk[]>();
  const preflightPhaseMap = new Map<string, PreflightPhase>();
  const containerPickerMap = new Map<string, ContainerSummary[]>();
  const inspectionMap = new Map<string, ContainerInspection>();
  const provisioningPhaseMap = new Map<string, number>();
  const acknowledgedRisks = new Map<string, Set<string>>(); // hostId → set of riskIds acknowledged
  const containerIdMap = new Map<string, string>(); // hostId → current containerId

  /** Check whether all pending risks for a host have been acknowledged. */
  function allRisksAcknowledged(hostId: string, risks: PendingRisk[]): boolean {
    const acked = acknowledgedRisks.get(hostId);
    if (!acked) return risks.length === 0;
    return risks.every((r) => acked.has(r.id));
  }

  const emit = (id: string, message: ServerMessage): void => sink?.(id, message);
  const setState = (id: string, state: HostConnectionState): void => {
    const host = hostMap.get(id);
    if (!host) return;
    hostMap.set(id, {
      ...host,
      state,
      wsUrl: state === "ready" ? wsUrl : host.wsUrl,
      ...(state === "ready" ? { failureLabel: undefined, failureAction: undefined, failureDetail: undefined } : {}),
    });
  };
  const setActivity = (id: string, activity: HostActivity): void => {
    const attention: SessionAttention[] = [];
    if (activity.waiting) attention.push({ sessionId: `${id}-waiting`, phase: "waiting", updatedAt: new Date().toISOString() });
    if (activity.failed) attention.push({ sessionId: `${id}-failed`, phase: "failed", updatedAt: new Date().toISOString() });
    emit(id, {
      type: "sessionStatus",
      runningIds: activity.running ? [`${id}-running`] : [],
      initializingIds: [],
      attention,
    } as ServerMessage);
    if (activity.unseen) {
      emit(id, {
        type: "sessionStatus",
        runningIds: [],
        initializingIds: [],
        attention,
      } as ServerMessage);
    }
  };

  const setPendingRisks = (id: string, risks: PendingRisk[]): void => {
    pendingRisksMap.set(id, risks);
    const host = hostMap.get(id);
    if (host) {
      hostMap.set(id, { ...host, pendingRisks: risks });
    }
  };

  const setPreflightPhase = (id: string, phase: PreflightPhase): void => {
    preflightPhaseMap.set(id, phase);
    const host = hostMap.get(id);
    if (host) {
      hostMap.set(id, { ...host, preflightPhase: phase });
    }
  };

  const setContainerPicker = (_id: string, containers: ContainerSummary[]): void => {
    // The dev provider uses a single global picker since testSshAndListContainers
    // is called before a profile is saved (no host id yet).
    containerPickerMap.set("__default__", containers);
  };

  const driveProvisioningPhase = (id: string, phase: number): void => {
    provisioningPhaseMap.set(id, phase);
    // Map phases 1-4 to connection states.
    if (phase === 4) {
      setState(id, "ready");
    } else {
      setState(id, "provisioning");
    }
  };

  const driveReplacement = (id: string): void => {
    // Generate a new container ID and set reconnecting state.
    containerIdMap.set(id, `replaced-${Date.now()}`);
    setState(id, "reconnecting");
  };

  const getInspection = (containerName: string): ContainerInspection | null => {
    return inspectionMap.get(containerName) ?? null;
  };

  const setInspection = (containerName: string, inspection: ContainerInspection): void => {
    inspectionMap.set(containerName, inspection);
  };

  return {
    supportsMultiHost: () => true,
    listHosts: async () => [...hostMap.values()].map((host) => ({ ...host })),
    connectHost: async (id) => {
      const host = hostMap.get(id);
      if (!host) throw new Error("Computer not found");
      if (host.state === "failed") throw new Error(host.failureLabel ?? "Connection failed");
      // If there are pending risks, transition to awaitingAcknowledgement instead of ready.
      const risks = pendingRisksMap.get(id);
      if (risks && risks.length > 0 && !allRisksAcknowledged(id, risks)) {
        setState(id, "awaitingAcknowledgement");
        return;
      }
      setState(id, "ready");
    },
    disconnectHost: async (id) => setState(id, "disconnected"),
    listProfiles: async () => [...profileMap.values()].map((p) => structuredClone(p)),
    getProfile: async (id) => {
      const p = profileMap.get(id);
      return p ? structuredClone(p) : null;
    },
    addProfile: async (profile) => {
      const stored = structuredClone(profile);
      profileMap.set(profile.id, stored);
      // If it's a Docker profile, add a corresponding host descriptor.
      if (profile.executionTarget.kind === "dockerContainer") {
        const hostId = profile.id;
        const containerName = profile.executionTarget.containerName;
        const { host: sshHost } = profile.sshDestination.includes("@")
          ? { host: profile.sshDestination.split("@")[1] ?? profile.sshDestination }
          : { host: profile.sshDestination };
        hostMap.set(hostId, {
          id: hostId,
          kind: "remote",
          label: profile.label,
          subtitle: `${containerName} via ${sshHost}`,
          state: "disconnected",
          isDockerTarget: true,
        });
        // Set a default container ID.
        containerIdMap.set(hostId, `dev-id-${containerName}`);
      } else {
        // Host profile — add a non-docker descriptor.
        hostMap.set(profile.id, {
          id: profile.id,
          kind: "remote",
          label: profile.label,
          subtitle: profile.sshDestination,
          state: "disconnected",
          isDockerTarget: false,
        });
      }
      return structuredClone(stored);
    },
    updateProfile: async (profile) => {
      profileMap.set(profile.id, structuredClone(profile));
    },
    deleteProfile: async (id) => {
      profileMap.delete(id);
      hostMap.delete(id);
      pendingRisksMap.delete(id);
      preflightPhaseMap.delete(id);
      provisioningPhaseMap.delete(id);
      acknowledgedRisks.delete(id);
      containerIdMap.delete(id);
    },
    acknowledgeRisk: async (id, riskId, fingerprint) => {
      const risks = pendingRisksMap.get(id);
      if (!risks || risks.length === 0) {
        throw new Error(`no pending risks for host ${id}`);
      }
      const risk = risks.find((r) => r.id === riskId);
      if (!risk) {
        throw new Error(`no pending risk ${riskId} for host ${id}`);
      }
      if (risk.fingerprint !== fingerprint) {
        throw new Error(`fingerprint mismatch for risk ${riskId}: target changed`);
      }
      let acked = acknowledgedRisks.get(id);
      if (!acked) {
        acked = new Set();
        acknowledgedRisks.set(id, acked);
      }
      acked.add(riskId);
    },
    cancelConnection: async (id) => {
      setState(id, "disconnected");
      pendingRisksMap.delete(id);
      preflightPhaseMap.delete(id);
      const host = hostMap.get(id);
      if (host) {
        hostMap.set(id, { ...host, pendingRisks: undefined, preflightPhase: undefined });
      }
    },
    resumeConnection: async (id) => {
      const host = hostMap.get(id);
      if (!host) return;
      // Resume from awaitingAcknowledgement / preflight → provisioning → ready.
      if (host.state === "awaitingAcknowledgement" || host.state === "preflight") {
        // Check if all risks are acknowledged.
        const risks = pendingRisksMap.get(id);
        if (risks && !allRisksAcknowledged(id, risks)) {
          // Still has unacknowledged risks — stay in awaitingAcknowledgement.
          return;
        }
        setState(id, "provisioning");
        // Clear pending risks.
        pendingRisksMap.delete(id);
        hostMap.set(id, { ...host, pendingRisks: undefined, preflightPhase: undefined, state: "provisioning" });
      }
    },
    // ── Docker container target methods ────────────────────────────────────
    supportsContainerTargets: () => true,
    testSshAndListContainers: async (_sshDestination, _port?) => {
      const containers = containerPickerMap.get("__default__") ?? DEV_CONTAINERS;
      return {
        sshOk: true,
        dockerPermission: "granted" as const,
        containers: structuredClone(containers),
      };
    },
    inspectContainer: async (_sshDestination, _port, containerName) => {
      const cached = inspectionMap.get(containerName);
      if (cached) return structuredClone(cached);
      return structuredClone(defaultInspection(containerName));
    },
    // ── DevHostControls ───────────────────────────────────────────────────
    setState,
    setActivity,
    emit,
    setMessageSink: (next) => { sink = next; },
    setPendingRisks,
    setPreflightPhase,
    setContainerPicker,
    driveProvisioningPhase,
    driveReplacement,
    getInspection,
    setInspection,
  };
}

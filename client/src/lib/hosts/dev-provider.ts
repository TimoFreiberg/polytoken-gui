import type { ServerMessage, SessionAttention } from "@pantoken/protocol";
import type { HostActivity, HostConnectionState, NativeHostDescriptor, RemoteProfile } from "./types.js";
import type { HostProvider } from "./provider.js";

export interface DevHostControls {
  setState(id: string, state: HostConnectionState): void;
  setActivity(id: string, activity: HostActivity): void;
  emit(id: string, message: ServerMessage): void;
  setMessageSink(sink: ((id: string, message: ServerMessage) => void) | null): void;
}

export type DevHostProvider = HostProvider & DevHostControls;

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

  return {
    supportsMultiHost: () => true,
    listHosts: async () => [...hostMap.values()].map((host) => ({ ...host })),
    connectHost: async (id) => {
      const host = hostMap.get(id);
      if (!host) throw new Error("Computer not found");
      if (host.state === "failed") throw new Error(host.failureLabel ?? "Connection failed");
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
      return structuredClone(stored);
    },
    updateProfile: async (profile) => {
      profileMap.set(profile.id, structuredClone(profile));
    },
    deleteProfile: async (id) => { profileMap.delete(id); hostMap.delete(id); },
    acknowledgeRisk: async () => {
      // No-op: dev provider does not model Docker preflight risks.
    },
    cancelConnection: async (id) => { setState(id, "disconnected"); },
    resumeConnection: async () => {
      // No-op: dev provider does not model preflight/acknowledgement pauses.
    },
    setState,
    setActivity,
    emit,
    setMessageSink: (next) => { sink = next; },
  };
}

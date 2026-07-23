// Host provider interface: the seam between the coordinator and the platform
// that manages host connections (Tauri in desktop, single-host in browser/e2e,
// fake in tests).
//
// No Svelte — this is a pure interface + factory functions.

import type {
  HostActivity,
  HostConnectionState,
  NativeHostDescriptor,
} from "./types.js";

/** The provider the coordinator depends on. In desktop builds this is backed
 *  by Tauri (stage 4); in browser/e2e builds it's a SingleHostProvider; in
 *  tests it's a FakeHostProvider. */
export interface HostProvider {
  /** Whether this provider exposes multiple selectable computers. */
  supportsMultiHost(): boolean;
  /** List local + saved remote computer descriptors. */
  listHosts(): Promise<NativeHostDescriptor[]>;
  /** Ensure/connect one remote computer; poll its state and bridge URL. */
  connectHost(id: string): Promise<void>;
  /** Disconnect one remote computer. */
  disconnectHost(id: string): Promise<void>;
  /** Existing remote-profile CRUD (remote only). */
  addProfile(profile: NativeHostDescriptor): Promise<NativeHostDescriptor>;
  updateProfile(profile: NativeHostDescriptor): Promise<void>;
  deleteProfile(id: string): Promise<void>;
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
  };
}

/** A provider for tests that can inject multiple logical host descriptors
 *  backed by mock WebSocket URLs, plus hooks to drive ready/running/unseen/
 *  waiting/reconnecting/failed states. */
export function createFakeHostProvider(
  hosts: NativeHostDescriptor[],
): {
  provider: HostProvider;
  driveState: (id: string, state: HostConnectionState) => void;
  driveActivity: (id: string, activity: HostActivity) => void;
} {
  // Clone the initial descriptors so the test can't mutate them.
  let hostMap = new Map<string, NativeHostDescriptor>(
    hosts.map((h) => [h.id, { ...h }]),
  );

  const provider: HostProvider = {
    supportsMultiHost() {
      return hosts.length > 1;
    },
    async listHosts() {
      return [...hostMap.values()];
    },
    async connectHost(id) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, { ...h, state: "ready" });
      }
    },
    async disconnectHost(id) {
      const h = hostMap.get(id);
      if (h) {
        hostMap.set(id, { ...h, state: "disconnected" });
      }
    },
    async addProfile(profile) {
      hostMap.set(profile.id, { ...profile });
      return profile;
    },
    async updateProfile(profile) {
      const existing = hostMap.get(profile.id);
      if (existing) {
        hostMap.set(profile.id, { ...existing, ...profile });
      }
    },
    async deleteProfile(id) {
      hostMap.delete(id);
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
  };
}

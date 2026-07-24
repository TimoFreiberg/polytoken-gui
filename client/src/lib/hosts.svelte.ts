// Host coordinator: owns all host descriptors, the selected host id, per-host
// WsClient instances, cached bootstrap messages, aggregate activity state, and
// the active-message routing boundary into PantokenStore.
//
// In single-host mode (browser/e2e), the coordinator is a passive observer —
// it tracks the local host's descriptor and activity but does NOT register an
// onMessage listener on the local host's WsClient (the store already does at
// L1005). The coordinator only registers onMessage listeners on REMOTE hosts'
// WsClient instances, where the store's listener is not wired.
//
// The coordinator imports the store (to call onServer/switchHost), but the
// store does NOT import the coordinator — avoiding a circular dependency.

import type { ClientMessage, ServerMessage } from "@pantoken/protocol";
import type { IWsClient, MessageListener } from "./ws-client.svelte.js";
import { WsClient } from "./ws-client.svelte.js";
import { compatibilityClient } from "./ws.svelte.js";
import { store } from "./store.svelte.js";
import type {
  HostActivity,
  HostSummary,
  NativeHostDescriptor,
} from "./hosts/types.js";
import { deriveIndicator } from "./hosts/activity.js";
import type { HostProvider } from "./hosts/provider.js";
import {
  applySessionStatus,
  clearOnSelect,
  initialUnreadState,
  type UnreadState,
} from "./hosts/unread.js";

/** Per-host entry in the coordinator's state map. */
interface HostEntry {
  descriptor: NativeHostDescriptor;
  client: IWsClient | null;
  unread: UnreadState;
  /** Cached bootstrap messages for this host. Only the latest of each type
   *  is retained (hello, sessionList, sessionStatus, seed, modelList, etc.),
   *  so memory is O(1) per host, not O(transcript length). */
  cachedBootstrap: Map<string, ServerMessage>;
  /** Unsubscribe function for the onMessage listener (remote hosts only). */
  unsubscribe: (() => void) | null;
}

/** Bootstrap message types that are cached for inactive hosts. */
const BOOTSTRAP_TYPES = new Set([
  "hello",
  "sessionList",
  "sessionStatus",
  "seed",
  "modelList",
  "modelDefaults",
  "commandList",
  "facetList",
  "fileIndex",
  "atRefs",
  "jobsList",
]);

export type ConnectHostResult =
  | { ok: true }
  | {
      ok: false;
      failure: {
        label: string;
        action?: string;
        detail?: string;
      };
    };

function statusText(
  descriptor: NativeHostDescriptor,
  activity: HostActivity,
): string {
  if (descriptor.failureLabel) return descriptor.failureLabel;
  if (descriptor.state === "failed") return descriptor.failureLabel ?? "Connection failed";
  if (descriptor.state === "disconnected") return "Offline";
  if (descriptor.state === "reconnecting") return "Reconnecting";
  if (["connecting", "testingSsh", "provisioning", "starting"].includes(descriptor.state)) return "Connecting";
  if (activity.failed) return "Session failed";
  if (activity.waiting) return "Waiting for input";
  if (activity.unseen) return "New activity";
  if (activity.running) return "Running";
  return "Connected";
}

export class HostCoordinator {
  /** All host descriptors (local + remote). */
  hosts = $state<NativeHostDescriptor[]>([]);
  /** UI-facing reactive projection; components do not inspect hostState. */
  summaries = $state<HostSummary[]>([]);
  /** Whether this provider supports native-style host switching. */
  readonly multiHostCapable: boolean;
  /** The selected host id. */
  selectedHostId = $state<string | null>(null);
  /** Per-host connection state + cached bootstrap. */
  private hostState = new Map<string, HostEntry>();
  /** The provider (Tauri in desktop, single-host in browser, fake in tests). */
  private provider: HostProvider;
  private unsubscribeLocal: (() => void) | null = null;

  /** Expose the provider for UI components that need Docker-specific methods
   *  (supportsContainerTargets, testSshAndListContainers, inspectContainer). */
  get hostProvider(): HostProvider {
    return this.provider;
  }

  constructor(provider: HostProvider) {
    this.provider = provider;
    this.multiHostCapable = provider.supportsMultiHost();
    this.unsubscribeLocal = compatibilityClient.onMessage((msg) => {
      this.observeLocalMessage(msg);
    });
  }

  /** Remove the single read-only compatibility observer. */
  cleanup(): void {
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    for (const entry of this.hostState.values()) {
      entry.unsubscribe?.();
      entry.client?.destroy();
      entry.client = null;
    }
  }

  /** Initialize: list hosts, select local. */
  async init(): Promise<void> {
    await this.refreshHosts();
    // Select the local host by default.
    const local = this.hosts.find((h) => h.id === "local");
    if (local) {
      await this.selectHost("local");
    }
  }

  /** Select a host. Switches the visible store. */
  async selectHost(id: string): Promise<ConnectHostResult> {
    const entry = this.hostState.get(id);
    if (!entry) return { ok: false, failure: { label: "Computer not found" } };

    // 1. If the target host is not connected, connect it first.
    // The local host does NOT get a WsClient created — its messages flow
    // through the compatibility singleton (wired by store.start()). Creating
    // a WsClient for the local host would double-register onMessage and cause
    // every server message to be processed twice.
    if (id !== "local" && !entry.client) {
      const result = await this.connectHost(id);
      if (!result.ok) return result;
    }

    // 2-3. Stash current host's per-client state + clear server-scoped state.
    // The store's switchHost does both.
    store.switchHost();

    // 4. Set the selected host id.
    this.selectedHostId = id;

    // 5. If the target host has cached bootstrap messages, replay them.
    if (entry.cachedBootstrap.size > 0) {
      const messages = this.orderBootstrapMessages(entry.cachedBootstrap);
      store.hydrateFromBootstrap(messages);
    }

    // 5b. Load the target host's namespaced per-client view state from localStorage.
    // These are client-only localStorage data (drafts, prompt history, etc.),
    // not server messages, so hydrateFromBootstrap() cannot restore them.
    const cachedHello = entry.cachedBootstrap.get("hello");
    const targetServerId =
      cachedHello && cachedHello.type === "hello"
        ? cachedHello.serverId
        : undefined;
    if (targetServerId) {
      store.loadPerClientState(targetServerId);
    }

    // 6. Clear the target host's unseen.
    entry.unread = clearOnSelect(entry.unread);

    // 7. If the target host's WsClient is connected, request a fresh seed.
    if (entry.client) {
      entry.client.send({ type: "requestSeed" } as ClientMessage);
    }
    this.refreshSummaries();
    return { ok: true };
  }

  /** Connect a remote host (lazy, first selection). Creates a WsClient and
   *  registers an onMessage listener that routes to the coordinator. */
  async connectHost(id: string): Promise<ConnectHostResult> {
    const entry = this.hostState.get(id);
    if (!entry) return { ok: false, failure: { label: "Computer not found" } };
    if (entry.client) return { ok: true }; // Already connected.

    const priorState = entry.descriptor.state;
    entry.descriptor = { ...entry.descriptor, state: "connecting" };
    this.refreshSummaries();
    try {
      await this.provider.connectHost(id);
      await this.refreshHosts();
      const updated = this.hostState.get(id);
      if (!updated?.descriptor.wsUrl) {
        entry.descriptor = {
          ...entry.descriptor,
          state: priorState,
          failureLabel: "Computer did not provide a connection",
        };
        this.refreshSummaries();
        return { ok: false, failure: { label: "Computer did not provide a connection" } };
      }
      entry.descriptor = updated.descriptor;
    } catch (error) {
      const e = error as { message?: string; failureAction?: string; failureDetail?: string };
      entry.descriptor = {
        ...entry.descriptor,
        state: priorState,
        failureLabel: e.message ?? "Connection failed",
        failureAction: e.failureAction,
        failureDetail: e.failureDetail,
      };
      this.refreshSummaries();
      return {
        ok: false,
        failure: {
          label: entry.descriptor.failureLabel ?? "Connection failed",
          action: entry.descriptor.failureAction,
          detail: entry.descriptor.failureDetail,
        },
      };
    }

    // Create a WsClient for this host.
    const client = new WsClient(entry.descriptor.wsUrl!);
    entry.client = client;

    // Register an onMessage listener that routes to the coordinator.
    // This is the message routing boundary: only messages from the selected
    // host are forwarded into PantokenStore. Messages for inactive hosts
    // update their cached bootstrap + activity state but are NOT folded
    // into the visible transcript.
    const listener: MessageListener = (msg) => {
      this.onHostMessage(id, msg);
    };
    entry.unsubscribe = client.onMessage(listener);

    // Connect the client.
    client.connect();
    this.refreshSummaries();
    return { ok: true };
  }

  /** Disconnect a remote host. */
  async disconnectHost(id: string): Promise<void> {
    const entry = this.hostState.get(id);
    if (!entry) return;

    if (entry.unsubscribe) {
      entry.unsubscribe();
      entry.unsubscribe = null;
    }
    if (entry.client) {
      entry.client.destroy();
      entry.client = null;
    }

    await this.provider.disconnectHost(id);
    await this.refreshHosts();
    this.refreshSummaries();
  }

  /** Get the WsClient for a host (or null if not connected). */
  getClient(id: string): IWsClient | null {
    return this.hostState.get(id)?.client ?? null;
  }

  /** Get the aggregate activity for a host. */
  getActivity(id: string): HostActivity {
    const entry = this.hostState.get(id);
    if (!entry) return { running: false, unseen: false, waiting: false, failed: false };
    return {
      running: entry.unread.running,
      unseen: entry.unread.unseen,
      waiting: entry.unread.waiting,
      failed: entry.unread.failed,
    };
  }

  /** Refresh host list from the provider. */
  async refreshHosts(): Promise<void> {
    const descriptors = await this.provider.listHosts();
    this.hosts = descriptors;

    // Add new hosts to the state map.
    for (const desc of descriptors) {
      if (!this.hostState.has(desc.id)) {
        this.hostState.set(desc.id, {
          descriptor: desc,
          client: null,
          unread: initialUnreadState(),
          cachedBootstrap: new Map(),
          unsubscribe: null,
        });
      } else {
        // Update the descriptor for existing hosts.
        const entry = this.hostState.get(desc.id)!;
        entry.descriptor = desc;
      }
    }
    this.refreshSummaries();
  }

  private refreshSummaries(): void {
    this.summaries = this.hosts.map((descriptor) => {
      const entry = this.hostState.get(descriptor.id);
      const currentDescriptor = entry?.descriptor ?? descriptor;
      const activity = this.getActivity(descriptor.id);
      return {
        descriptor: currentDescriptor,
        activity,
        baselined: entry?.unread.baselined ?? false,
        selected: currentDescriptor.id === this.selectedHostId,
        indicator: deriveIndicator(
          activity,
          currentDescriptor.state,
          Boolean(currentDescriptor.failureLabel),
        ),
        statusText: statusText(currentDescriptor, activity),
      };
    });
  }

  private observeLocalMessage(msg: ServerMessage): void {
    const entry = this.hostState.get("local");
    if (!entry) return;
    this.cacheBootstrapMessage(entry, msg);
    if (msg.type === "sessionStatus") {
      entry.unread = applySessionStatus(
        entry.unread,
        {
          runningIds: msg.runningIds,
          initializingIds: msg.initializingIds,
          attention: msg.attention,
        },
        this.selectedHostId === "local",
      );
    }
    this.refreshSummaries();
  }

  /** The selected host's WsClient (for compatibility delegation).
   *  For the local host, returns the compatibility singleton (whose messages
   *  are wired by store.start()). For remote hosts, returns the coordinator-
   *  created WsClient. */
  get selectedClient(): IWsClient | null {
    if (!this.selectedHostId) return null;
    if (this.selectedHostId === "local") return compatibilityClient;
    return this.getClient(this.selectedHostId);
  }

  // ── Message routing boundary ──────────────────────────────────────────

  /** Route a targeted dev/provider message through the normal host boundary. */
  receiveHostMessage(hostId: string, msg: ServerMessage): void {
    this.onHostMessage(hostId, msg);
  }

  /** Handle a message from a host's WsClient. */
  private onHostMessage(hostId: string, msg: ServerMessage): void {
    const entry = this.hostState.get(hostId);
    if (!entry) return;

    // 1. Update cached bootstrap messages (always, for all hosts).
    this.cacheBootstrapMessage(entry, msg);

    // 2. Update per-host activity from sessionStatus (always, for all hosts).
    if (msg.type === "sessionStatus") {
      const isActive = hostId === this.selectedHostId;
      entry.unread = applySessionStatus(
        entry.unread,
        {
          runningIds: msg.runningIds,
          initializingIds: msg.initializingIds,
          attention: msg.attention,
        },
        isActive,
      );
    }
    this.refreshSummaries();

    // 3. Only forward to the visible store if this is the selected host.
    if (hostId === this.selectedHostId) {
      store.onServer(msg);
    }
  }

  /** Cache a bootstrap message for an inactive host. Only the latest of each
   *  type is retained. Transcript events are NOT cached. */
  private cacheBootstrapMessage(entry: HostEntry, msg: ServerMessage): void {
    if (BOOTSTRAP_TYPES.has(msg.type)) {
      entry.cachedBootstrap.set(msg.type, msg);
    }
  }

  /** Order cached bootstrap messages for replay: hello first, then the rest
   *  in a sensible order (sessionList, sessionStatus, modelList, etc.),
   *  with seed last (so the store adopts the transcript after metadata). */
  private orderBootstrapMessages(
    cache: Map<string, ServerMessage>,
  ): ServerMessage[] {
    const order = [
      "hello",
      "sessionList",
      "sessionStatus",
      "modelList",
      "modelDefaults",
      "commandList",
      "facetList",
      "fileIndex",
      "atRefs",
      "jobsList",
      "seed",
    ];
    const messages: ServerMessage[] = [];
    for (const type of order) {
      const msg = cache.get(type);
      if (msg) messages.push(msg);
    }
    return messages;
  }
}

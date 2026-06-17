// The real driver: embeds a pi AgentSessionRuntime and presents it through
// PilotDriver, the same seam the mock implements. Selected via PILOT_DRIVER=pi. Uses
// the user's existing pi config (model + credentials from ~/.pi) unless overridden.
//
// Uses the RUNTIME (not a bare AgentSession) so the active session can be SWITCHED at
// runtime (D13 Increment 2). Per the SDK, replacing the active session re-points
// `runtime.session`, disposes the old one, and requires re-`bindExtensions` +
// re-`subscribe` — so bind/subscribe live in a re-runnable `bindCurrent()`.

import { basename } from "node:path";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  HostUiResponse,
  SessionDriverEvent,
  SessionListEntry,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
} from "@pilot/protocol";
import type { PilotDriver } from "../driver.js";
import { mapPiEvent } from "./event-map.js";
import { type HistoryMessage, historyToEvents } from "./history-map.js";
import { makeTrustResolver } from "./trust.js";
import { PiUiBridge } from "./ui-bridge.js";

export interface PiDriverOptions {
  cwd?: string;
}

export async function createPiDriver(
  opts: PiDriverOptions = {},
): Promise<PilotDriver> {
  const cwd = opts.cwd ?? process.cwd();
  // The operator-launched cwd is implicitly trusted; sessions switched to other
  // cwds at runtime are gated by the trust resolver below (D12).
  const launchCwd = cwd;

  // The documented runtime factory: recreate cwd-bound services and a session.
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      // Without this, pi leaves projectTrusted=true and auto-loads every project's
      // .pi resources — the D12 gap. Resolve trust per cwd instead (non-interactive
      // MVP; honors trust.json, trusts launchCwd, denies other untrusted paths).
      resourceLoaderReloadOptions: {
        resolveProjectTrust: makeTrustResolver(cwd, cwd === launchCwd),
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  // Persist + resume like the CLI: continue the most recent session for this cwd,
  // writing to ~/.pi/agent/sessions/ so an SSH `pi` peer sees the same files (D13).
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.continueRecent(cwd),
  });

  let session = runtime.session;
  let ref: SessionRef = { workspaceId: cwd, sessionId: session.sessionId };
  const listeners = new Set<(ev: SessionDriverEvent) => void>();
  const now = () => String(Date.now());

  const emit = (ev: SessionDriverEvent) => {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[pi] listener error", e);
      }
    }
  };

  const bridge = new PiUiBridge(ref, emit, now);

  // Reads the CURRENT session/ref (both reassigned on swap), so it stays correct
  // across switchSession/newSession.
  const snapshot = (status: SessionStatus): SessionSnapshot => {
    const m = session.model;
    return {
      ref,
      workspace: { workspaceId: cwd, path: cwd, displayName: basename(cwd) },
      title: session.sessionName ?? "pi session",
      status,
      updatedAt: now(),
      config: {
        provider: m && typeof m.provider === "string" ? m.provider : undefined,
        modelId: m?.id,
        thinkingLevel: session.thinkingLevel,
      },
    };
  };

  const ctx = {
    get ref() {
      return ref;
    },
    now,
    toolMeta: (name: string) => {
      const t = session.getAllTools().find((x) => x.name === name);
      return { label: undefined, description: t?.description };
    },
    snapshot,
  };

  // (Re)bind extensions + (re)subscribe the current session. Called once at startup
  // and again after every session swap (subscriptions/bindings are per-AgentSession).
  let unsubCurrent: (() => void) | null = null;
  async function bindCurrent(): Promise<void> {
    unsubCurrent?.(); // detach the previous session's listener
    session = runtime.session;
    ref = { workspaceId: cwd, sessionId: session.sessionId };
    bridge.rebind(ref); // point the bridge at the new session; drop stale dialogs
    await session.bindExtensions({
      uiContext: bridge as unknown as ExtensionUIContext,
    });
    unsubCurrent = session.subscribe((ev) => {
      for (const out of mapPiEvent(ev, ctx)) emit(out);
    });
  }
  await bindCurrent();

  // The seed for the current session: a sessionOpened snapshot + its replayed
  // history. Emitted to the first subscriber; returned (not emitted) on a swap so
  // the hub can reset state and fold it atomically.
  const currentSeed = (): SessionDriverEvent[] => [
    {
      sessionRef: ref,
      timestamp: now(),
      type: "sessionOpened",
      snapshot: snapshot(session.isStreaming ? "running" : "idle"),
    },
    ...historyToEvents(
      session.messages as unknown as readonly HistoryMessage[],
      { ref, idleSnapshot: snapshot("idle"), toolMeta: ctx.toolMeta },
    ),
  ];

  const toEntry = (
    info: Awaited<ReturnType<typeof SessionManager.list>>[number],
  ): SessionListEntry => ({
    sessionId: info.id,
    path: info.path,
    cwd: info.cwd,
    displayName: info.name,
    preview: info.firstMessage ?? "",
    messageCount: info.messageCount,
    updatedAt: info.modified.toISOString(),
    createdAt: info.created.toISOString(),
    parentSessionPath: info.parentSessionPath,
  });

  return {
    subscribe(l) {
      listeners.add(l);
      // Seed the first (only) subscriber — the hub — synchronously so no event races.
      if (listeners.size === 1) for (const ev of currentSeed()) emit(ev);
      return () => listeners.delete(l);
    },

    prompt(text, deliverAs) {
      emit({
        sessionRef: ref,
        timestamp: now(),
        type: "userMessage",
        id: `u-${now()}`,
        text,
      });
      const options =
        session.isStreaming && deliverAs
          ? { streamingBehavior: deliverAs }
          : undefined;
      session.prompt(text, options).catch((e) => {
        emit({
          sessionRef: ref,
          timestamp: now(),
          type: "runFailed",
          error: { message: String(e) },
        });
      });
    },

    abort() {
      session.abort().catch(() => {});
    },

    respondUi(response: HostUiResponse) {
      bridge.resolve(response);
    },

    async listSessions() {
      // Sessions for THIS workspace (listAll() spans every project — too broad here).
      const infos = await SessionManager.list(cwd);
      return infos.map(toEntry);
    },

    async openSession(path: string) {
      const res = await runtime.switchSession(path);
      if (res?.cancelled) throw new Error("session switch was cancelled");
      await bindCurrent();
      return currentSeed();
    },

    async newSession() {
      const res = await runtime.newSession();
      if (res?.cancelled) throw new Error("new session was cancelled");
      await bindCurrent();
      return currentSeed();
    },
  };
}

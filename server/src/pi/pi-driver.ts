// The real driver: embeds a pi AgentSession and presents it through PilotDriver,
// the same seam the mock implements. Selected via PILOT_DRIVER=pi. Uses the user's
// existing pi config (model + credentials from ~/.pi) unless overridden.
//
// NOTE: this path runs a live coding agent that executes tools in `cwd`. It has not
// been exercised end-to-end yet (needs provider credentials) — first live bring-up
// is a known next step. The pure pieces it composes (event-map, ui-bridge) are
// unit-tested.

import { basename } from "node:path";
import {
  createAgentSession,
  type ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  HostUiResponse,
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
} from "@pilot/protocol";
import type { PilotDriver } from "../driver.js";
import { mapPiEvent } from "./event-map.js";
import { type HistoryMessage, historyToEvents } from "./history-map.js";
import { PiUiBridge } from "./ui-bridge.js";

export interface PiDriverOptions {
  cwd?: string;
}

export async function createPiDriver(
  opts: PiDriverOptions = {},
): Promise<PilotDriver> {
  const cwd = opts.cwd ?? process.cwd();
  // Persist like the CLI: continue the most recent session for this cwd (or create a
  // fresh one), writing to ~/.pi/agent/sessions/ so a SSH `pi` peer sees the same
  // files. This is what makes pi's .jsonl the authoritative store (D13) — pilot's
  // in-memory transcript is rebuilt from it on load via historyToEvents below.
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.continueRecent(cwd),
  });

  const ref: SessionRef = { workspaceId: cwd, sessionId: session.sessionId };
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
  // Cast: the bridge implements the remote-relevant subset; TUI-only members are
  // stubbed (see ui-bridge.ts). pi never calls those in a headless session.
  await session.bindExtensions({
    uiContext: bridge as unknown as ExtensionUIContext,
  });

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
    ref,
    now,
    toolMeta: (name: string) => {
      const t = session.getAllTools().find((x) => x.name === name);
      return { label: undefined, description: t?.description };
    },
    snapshot,
  };

  session.subscribe((ev) => {
    for (const out of mapPiEvent(ev, ctx)) emit(out);
  });

  return {
    subscribe(l) {
      listeners.add(l);
      // Seed the first (only) subscriber — the hub — with an opened snapshot so its
      // state isn't blank before the first pi event. Synchronous => no lost-event race.
      if (listeners.size === 1) {
        emit({
          sessionRef: ref,
          timestamp: now(),
          type: "sessionOpened",
          snapshot: snapshot(session.isStreaming ? "running" : "idle"),
        });
        // Rebuild the transcript from the resumed session's stored messages, so a
        // reopened/restarted session shows its history instead of starting blank.
        for (const ev of historyToEvents(
          session.messages as unknown as readonly HistoryMessage[],
          { ref, idleSnapshot: snapshot("idle"), toolMeta: ctx.toolMeta },
        ))
          emit(ev);
      }
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
  };
}

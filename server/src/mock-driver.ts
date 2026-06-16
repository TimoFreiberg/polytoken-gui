// Replays deterministic fixture scripts as a PilotDriver. Stands in for a real pi
// session so the whole UI pipeline can be built and screenshot-verified without a
// live model or API keys.

import type { HostUiResponse, SessionDriverEvent } from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";
import {
  ambient,
  confirmDialog,
  greeting,
  inputDialog,
  promptReply,
  type ScriptStep,
  SESSION_REF,
  trustDialog,
} from "./fixtures.js";

export class MockDriver implements PilotDriver {
  private listeners = new Set<(ev: SessionDriverEvent) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pendingDialogs = new Set<string>();

  subscribe(listener: (ev: SessionDriverEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: SessionDriverEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error("[mock] listener error", e);
      }
    }
  }

  /** Schedule a script's steps with their cumulative delays. */
  private play(steps: ScriptStep[]): void {
    let t = 0;
    for (const step of steps) {
      t += step.wait;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.emit(step.event);
        if (
          step.event.type === "hostUiRequest" &&
          "timeoutMs" in step.event.request
        ) {
          // remember dialogs so respondUi / abort can settle them
          this.pendingDialogs.add(step.event.request.requestId);
        }
      }, t);
      this.timers.add(timer);
    }
  }

  /** Emit the initial conversation so a fresh server isn't blank. */
  bootstrap(): void {
    this.play(greeting());
  }

  prompt(text: string): void {
    this.play(promptReply(text));
  }

  abort(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "runCompleted",
      snapshot: {
        ref: SESSION_REF,
        workspace: {
          workspaceId: SESSION_REF.workspaceId,
          path: "/Users/timo/src/pilot",
        },
        title: "Wire up the WebSocket bridge",
        status: "idle",
        updatedAt: String(Date.now()),
      },
    });
  }

  respondUi(response: HostUiResponse): void {
    this.pendingDialogs.delete(response.requestId);
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiResolved",
      requestId: response.requestId,
    });
    const summary =
      "cancelled" in response
        ? "Dialog cancelled."
        : "confirmed" in response
          ? response.confirmed
            ? "Approved — continuing."
            : "Denied — skipping that step."
          : `Received: ${response.value}`;
    this.emit({
      sessionRef: SESSION_REF,
      timestamp: String(Date.now()),
      type: "hostUiRequest",
      request: {
        kind: "notify",
        requestId: `resolved-${response.requestId}`,
        message: summary,
        level: "info",
      },
    });
  }

  runScript(name: string): void {
    const map: Record<string, () => ScriptStep[]> = {
      confirm: confirmDialog,
      trust: trustDialog,
      input: inputDialog,
      ambient,
      reply: () => promptReply("Show me the streamed reply script."),
    };
    const make = map[name];
    if (make) this.play(make());
  }
}

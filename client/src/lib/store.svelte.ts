// The client store: holds a reactive SessionState, adopts server snapshots, and
// folds incremental events with the SAME reducer the server runs. Per-client view
// state (composer draft) lives here too and is intentionally never sent upstream.

import {
  foldEvent,
  type HostUiResponse,
  initialSessionState,
  type ServerMessage,
  type SessionState,
} from "@pilot/protocol";
import {
  connect,
  type ConnectionState,
  connectionState,
  onMessage,
  send,
} from "./ws.svelte.js";

class PilotStore {
  session = $state<SessionState>(initialSessionState());
  serverId = $state<string | null>(null);
  ready = $state(false);

  // per-client view state — local only
  composerDraft = $state("");

  get connection(): ConnectionState {
    return connectionState();
  }
  get streaming(): boolean {
    return this.session.status === "running";
  }

  start(): void {
    onMessage((msg) => this.onServer(msg));
    connect();
  }

  private onServer(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        this.serverId = msg.serverId;
        break;
      case "snapshot":
        this.session = msg.state;
        this.ready = true;
        break;
      case "event":
        foldEvent(this.session, msg.event);
        break;
      case "error":
        console.error("[server error]", msg.message);
        break;
    }
  }

  prompt(text: string, deliverAs?: "steer" | "followUp"): void {
    const t = text.trim();
    if (!t) return;
    send({ type: "prompt", text: t, deliverAs });
    this.composerDraft = "";
  }
  abort(): void {
    send({ type: "abort" });
  }
  respondUi(response: HostUiResponse): void {
    send({ type: "respondUi", response });
  }
  mock(script: string): void {
    send({ type: "mock", script });
  }
}

export const store = new PilotStore();

// The session hub: holds the authoritative folded SessionState, folds every
// driver event into it, and fans events out to all connected WS clients. New
// clients get hello + a full snapshot so they catch up without replaying history.

import {
  type ClientMessage,
  foldEvent,
  initialSessionState,
  PROTOCOL_VERSION,
  type ServerMessage,
  type SessionDriverEvent,
  type SessionState,
} from "@pilot/protocol";
import type { PilotDriver } from "./driver.js";

export type Send = (msg: ServerMessage) => void;

export class SessionHub {
  private state: SessionState = initialSessionState();
  private clients = new Set<Send>();
  private serverId = `pilot-${Math.floor(Date.now() / 1000)}`;

  constructor(private driver: PilotDriver) {
    driver.subscribe((ev) => this.onEvent(ev));
  }

  private onEvent(ev: SessionDriverEvent): void {
    foldEvent(this.state, ev);
    this.broadcast({ type: "event", event: ev });
  }

  private broadcast(msg: ServerMessage): void {
    for (const send of this.clients) {
      try {
        send(msg);
      } catch (e) {
        console.error("[hub] send failed", e);
      }
    }
  }

  /** Register a client. Synchronously sends hello + snapshot, then live events. */
  addClient(send: Send): () => void {
    this.clients.add(send);
    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverId: this.serverId,
    });
    send({ type: "snapshot", state: this.snapshot() });
    return () => this.clients.delete(send);
  }

  handleClient(send: Send, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
      case "ping":
        return;
      case "prompt":
        this.driver.prompt(msg.text, msg.deliverAs);
        return;
      case "abort":
        this.driver.abort();
        return;
      case "respondUi":
        this.driver.respondUi(msg.response);
        return;
      case "mock":
        this.driver.runScript?.(msg.script);
        return;
      default:
        send({
          type: "error",
          message: `unknown message: ${(msg as { type: string }).type}`,
        });
    }
  }

  /** A JSON-safe deep copy of current state (foldEvent mutates in place). */
  snapshot(): SessionState {
    return structuredClone(this.state);
  }

  clientCount(): number {
    return this.clients.size;
  }
}

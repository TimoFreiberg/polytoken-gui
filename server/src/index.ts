// Pilot server: Bun.serve with a WebSocket bridge + an agent-legible /debug/state
// introspection endpoint. M0 wires the deterministic mock driver; M5 swaps in the
// real pi-sdk driver behind the same PilotDriver seam.

import {
  type ClientMessage,
  parseClientMessage,
  type ServerMessage,
} from "@pilot/protocol";
import type { ServerWebSocket } from "bun";
import { SessionHub } from "./hub.js";
import { MockDriver } from "./mock-driver.js";

const PORT = Number(process.env.PILOT_PORT ?? 8787);

const driver = new MockDriver();
const hub = new SessionHub(driver);
driver.bootstrap();

// Track each socket's unsubscribe so close() can detach it from the hub.
const unsub = new WeakMap<ServerWebSocket<unknown>, () => void>();

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("websocket upgrade failed", { status: 426 });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, clients: hub.clientCount() });
    }

    // Agent-legible introspection: the full authoritative state as JSON.
    if (url.pathname === "/debug/state") {
      return Response.json(hub.snapshot(), {
        headers: { "access-control-allow-origin": "*" },
      });
    }

    return new Response("pilot server", { status: 200 });
  },

  websocket: {
    open(ws) {
      const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));
      unsub.set(ws, hub.addClient(send));
      console.log(`[ws] client connected (${hub.clientCount()} total)`);
    },
    message(ws, raw) {
      const msg: ClientMessage | null = parseClientMessage(
        typeof raw === "string" ? raw : raw.toString(),
      );
      if (!msg) return;
      const send = (m: ServerMessage) => ws.send(JSON.stringify(m));
      hub.handleClient(send, msg);
    },
    close(ws) {
      unsub.get(ws)?.();
      unsub.delete(ws);
      console.log(`[ws] client disconnected (${hub.clientCount()} total)`);
    },
  },
});

console.log(
  `[pilot] server on http://localhost:${server.port}  (ws: /ws, introspect: /debug/state)`,
);

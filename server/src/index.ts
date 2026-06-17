// Pilot server: Bun.serve with a WebSocket control channel, an agent-legible
// /debug introspection surface, an optional auth-token gate, and static serving of
// the built client (so prod is one process behind `tailscale serve`). M0 wires the
// deterministic mock driver; M5 swaps in the real pi-sdk driver behind PilotDriver.

import { type ServerMessage, parseClientMessage } from "@pilot/protocol";
import type { ServerWebSocket } from "bun";
import { config, tokenFromRequest, tokenOk } from "./config.js";
import type { PilotDriver } from "./driver.js";
import { SessionHub } from "./hub.js";
import { MockDriver } from "./mock-driver.js";
import { PushService } from "./push.js";
import { serveStatic } from "./static.js";

interface WsData {
  authed: boolean;
  unsub: (() => void) | null;
}

// Driver selection. Default is the deterministic mock; PILOT_DRIVER=pi embeds a
// live pi AgentSession (dynamic import so the SDK never loads in mock mode).
let driver: PilotDriver;
let mock: MockDriver | null = null;
if (process.env.PILOT_DRIVER === "pi") {
  const { createPiDriver } = await import("./pi/pi-driver.js");
  driver = await createPiDriver({ cwd: process.env.PILOT_CWD });
} else {
  mock = new MockDriver();
  driver = mock;
}
const push = new PushService();
const hub = new SessionHub(driver, (n) => {
  void push.sendToAll(n);
});
mock?.bootstrap(); // replay the greeting fixture now that the hub is subscribed

const send = (ws: ServerWebSocket<WsData>, msg: ServerMessage) =>
  ws.send(JSON.stringify(msg));

function authenticate(ws: ServerWebSocket<WsData>): void {
  ws.data.authed = true;
  ws.data.unsub = hub.addClient((m) => send(ws, m));
  console.log(`[ws] client authed (${hub.clientCount()} total)`);
}

const server = Bun.serve<WsData>({
  port: config.port,
  hostname: config.host,
  idleTimeout: 120,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { authed: false, unsub: null } }))
        return undefined;
      return new Response("websocket upgrade failed", { status: 426 });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, clients: hub.clientCount() });
    }

    // Web Push: VAPID key handout, (un)subscribe, and a manual test trigger. Gated
    // by the same app token as everything else (the public key isn't secret, but
    // keeping the surface uniform is simpler). Not behind config.debug — it's a
    // real feature, not introspection.
    if (url.pathname.startsWith("/push/")) {
      if (!tokenOk(tokenFromRequest(req, url)))
        return new Response("unauthorized", { status: 401 });
      try {
        if (url.pathname === "/push/vapid")
          return Response.json({ publicKey: push.publicKey });
        if (url.pathname === "/push/subscribe" && req.method === "POST") {
          push.add(await req.json());
          return Response.json({ ok: true });
        }
        if (url.pathname === "/push/unsubscribe" && req.method === "POST") {
          const { endpoint } = (await req.json()) as { endpoint?: string };
          if (endpoint) push.remove(endpoint);
          return Response.json({ ok: true });
        }
        if (url.pathname === "/push/test" && req.method === "POST") {
          const sent = await push.sendToAll({
            title: "pilot",
            body: "Test push ✅ — if you see this on a closed phone, it works.",
            tag: "pilot-test",
          });
          return Response.json({ ok: true, subscriptions: push.count, sent });
        }
      } catch (e) {
        return new Response(`bad request: ${String(e)}`, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    }

    if (url.pathname.startsWith("/debug/")) {
      if (!config.debug) return new Response("debug disabled", { status: 404 });
      if (!tokenOk(tokenFromRequest(req, url)))
        return new Response("unauthorized", { status: 401 });
      const headers = { "access-control-allow-origin": "*" };
      if (url.pathname === "/debug/state")
        return Response.json(hub.snapshot(), { headers });
      if (url.pathname === "/debug/reset") {
        hub.reset();
        return Response.json({ ok: true }, { headers });
      }
      return new Response("not found", { status: 404 });
    }

    // Serve the built client in prod; in dev Vite serves it and proxies here.
    const asset = await serveStatic(url.pathname);
    if (asset) return asset;
    return new Response("pilot server — no client build (run `bun run dev`)", {
      status: 200,
    });
  },

  websocket: {
    open(ws) {
      // No token configured -> open access (dev). Otherwise wait for an authed hello.
      if (config.token === null) authenticate(ws);
    },
    message(ws, raw) {
      const msg = parseClientMessage(
        typeof raw === "string" ? raw : raw.toString(),
      );
      if (!msg) return;
      if (!ws.data.authed) {
        if (msg.type === "hello" && tokenOk(msg.auth)) authenticate(ws);
        else {
          send(ws, { type: "error", message: "unauthorized" });
          ws.close();
        }
        return;
      }
      if (msg.type === "hello") return; // already authed
      hub.handleClient((m) => send(ws, m), msg);
    },
    close(ws) {
      ws.data.unsub?.();
      ws.data.unsub = null;
    },
  },
});

console.log(
  `[pilot] http://${config.host}:${server.port}  driver=${process.env.PILOT_DRIVER === "pi" ? "pi" : "mock"}  token=${config.token ? "required" : "off"}  debug=${config.debug}`,
);

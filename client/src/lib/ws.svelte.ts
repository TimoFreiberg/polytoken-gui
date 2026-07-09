// Reconnecting WebSocket singleton with reactive Svelte 5 state.
// Ported near-verbatim from KellerComm (frontend/src/lib/ws.svelte.ts), retyped
// to pantoken's ClientMessage/ServerMessage envelope.

import {
  type ClientMessage,
  parseServerMessage,
  type ResumeToken,
  type ServerMessage,
} from "@pantoken/protocol";
import { getToken } from "./auth.js";

export type ConnectionState =
  "disconnected" | "connecting" | "connected" | "reconnecting";

type MessageListener = (msg: ServerMessage) => void;

let _state = $state<ConnectionState>("disconnected");
let _reconnectAttempt = $state(0);

export function connectionState(): ConnectionState {
  return _state;
}
export function reconnectAttempts(): number {
  return _reconnectAttempt;
}

let ws: WebSocket | null = null;
let listeners: MessageListener[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Handshake watchdog: a blackholed connect (SYN into a dead Tailscale route)
// can sit CONNECTING for minutes with NO retry timer armed — "Reconnecting…"
// would lie. If the socket hasn't opened within the window, kill it and fall
// back to the normal backoff schedule.
let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
const CONNECT_TIMEOUT_MS = 8_000;
// Heartbeat: a half-open socket (phone slept, NAT dropped the stream mid-sleep, no
// FIN/RST ever arrives) sits in `_state === "connected"` forever — onclose/onerror never
// fire, so the "live" indicator lies. While connected, ping on an interval; ANY inbound
// frame (not just a reply pong) counts as proof of life, tracked in `lastInboundAt`. A
// ping that gets no traffic back within the watchdog window means the transport is dead —
// force it closed and fall into the normal reconnect/backoff flow, same remedy as the
// handshake watchdog above.
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null;
let lastInboundAt = 0;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_WATCHDOG_MS = 10_000;
let intentionalClose = false;
// The store registers a provider for the focused session's fold watermark; the
// (re)connect hello carries it so the server can tail-replay just the missed
// events instead of re-shipping the whole transcript (protocol v2 resume).
let resumeProvider: (() => ResumeToken | null) | null = null;

export function setResumeProvider(fn: () => ResumeToken | null): void {
  resumeProvider = fn;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function getReconnectDelay(): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** _reconnectAttempt, MAX_DELAY_MS);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

function buildWsUrl(): string {
  const configured = import.meta.env.VITE_PANTOKEN_WS_URL;
  if (configured) return configured;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function scheduleReconnect(): void {
  if (intentionalClose) return;
  _state = "reconnecting";
  const delay = getReconnectDelay();
  _reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect();
  }, delay);
}

function clearConnectWatchdog(): void {
  if (connectWatchdog !== null) {
    clearTimeout(connectWatchdog);
    connectWatchdog = null;
  }
}

function clearHeartbeatWatchdog(): void {
  if (heartbeatWatchdog !== null) {
    clearTimeout(heartbeatWatchdog);
    heartbeatWatchdog = null;
  }
}

/** Stop the recurring ping + drop any pending watchdog. Called from `cleanupSocket` so
 * every path that discards a socket also stops heartbeating the one it's replacing. */
function stopHeartbeat(): void {
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  clearHeartbeatWatchdog();
}

/** Start heartbeating a freshly-connected socket. Called once per connection, right
 * after the server's `hello` flips `_state` to "connected". */
function startHeartbeat(): void {
  stopHeartbeat();
  lastInboundAt = Date.now();
  heartbeatInterval = setInterval(() => {
    // Battery: skip the routine ping while backgrounded — a wake (visibilitychange/
    // pageshow/online) probes liveness explicitly instead, see handleWake below.
    if (typeof document !== "undefined" && document.hidden) return;
    probeLiveness();
  }, HEARTBEAT_INTERVAL_MS);
}

/** Send a ping and arm a watchdog: if no inbound traffic (a pong or anything else)
 * arrives before it fires, the socket is half-open — force-close it and fall back to
 * the normal reconnect/backoff flow. At most one watchdog is ever pending; re-probing
 * clears and re-arms it rather than stacking. */
function probeLiveness(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const armedSocket = ws;
  const sentAt = Date.now();
  send({ type: "ping" });
  clearHeartbeatWatchdog();
  heartbeatWatchdog = setTimeout(() => {
    heartbeatWatchdog = null;
    // A replacement socket already took over — not this watchdog's problem.
    if (ws !== armedSocket) return;
    if (lastInboundAt >= sentAt) return; // traffic arrived after the ping — still alive
    console.warn(
      "[ws] heartbeat watchdog expired — socket looks half-open, forcing reconnect",
    );
    cleanupSocket(); // detaches onclose so the close below can't double-schedule
    armedSocket.close();
    scheduleReconnect();
  }, HEARTBEAT_WATCHDOG_MS);
}

function cleanupSocket(): void {
  // Every path that discards a socket (close, force-reconnect, disconnect)
  // also invalidates its handshake watchdog and heartbeat.
  clearConnectWatchdog();
  stopHeartbeat();
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws = null;
  }
}

function doConnect(): void {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;
  cleanupSocket();
  // A hidden tab skips connecting to save resources (e.g. a backgrounded PWA).
  // But under the Vite dev server the preview/automation tab runs permanently
  // backgrounded (visibilityState stays "hidden", no visibilitychange ever
  // fires), so this guard would wedge it "Offline" forever. Always connect in
  // dev; the prod bundle keeps the battery guard.
  if (!import.meta.env.DEV && document.visibilityState === "hidden") return;

  const url = buildWsUrl();
  _state = _reconnectAttempt === 0 ? "connecting" : "reconnecting";
  ws = new WebSocket(url);

  // Arm the handshake watchdog for THIS socket. The identity guard matters:
  // forceReconnect may have swapped the socket before the timer fires, and the
  // watchdog must never kill a replacement it didn't arm for.
  const armed = ws;
  clearConnectWatchdog();
  connectWatchdog = setTimeout(() => {
    connectWatchdog = null;
    if (ws !== armed || armed.readyState !== WebSocket.CONNECTING) return;
    console.warn("[ws] connect timed out — closing and retrying with backoff");
    cleanupSocket(); // detaches onclose so the close below can't double-schedule
    armed.close();
    // Deliberately NOT resetting _reconnectAttempt: a timed-out handshake is a
    // failed attempt, so the backoff keeps growing.
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearConnectWatchdog();
    _reconnectAttempt = 0;
    send({
      type: "hello",
      auth: getToken() ?? undefined,
      resume: resumeProvider?.() ?? undefined,
    });
  };

  ws.onmessage = (event: MessageEvent) => {
    // ANY inbound frame is proof of life for the heartbeat watchdog — stamped before
    // parsing so even a frame we fail to make sense of still counts (a parse failure
    // below just means it isn't forwarded to listeners).
    lastInboundAt = Date.now();
    const msg = parseServerMessage(event.data as string);
    if (!msg) return;
    // OPEN only means the transport is up. Treat the socket as usable after the
    // server's authenticated hello, so durable prompts never race ahead of auth.
    if (msg.type === "hello") {
      _state = "connected";
      startHeartbeat();
    }
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (e) {
        console.error("[ws] listener error:", e);
      }
    }
  };

  ws.onclose = () => {
    cleanupSocket();
    if (!intentionalClose) scheduleReconnect();
    else _state = "disconnected";
  };

  ws.onerror = (event) => console.error("[ws] error:", event);
}

export function connect(): void {
  intentionalClose = false;
  _reconnectAttempt = 0;
  doConnect();
}

/** User-requested reconnect: cancel any backoff and open a fresh socket now. */
export function forceReconnect(): void {
  intentionalClose = false;
  _reconnectAttempt = 0;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    const closing = ws;
    cleanupSocket();
    closing.close();
  }
  doConnect();
}

/** Send immediately when the authenticated socket is open. Callers that need
 * reliability keep their own durable queue and retry when this returns false. */
export function send(msg: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export function disconnect(): void {
  intentionalClose = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    const closing = ws;
    cleanupSocket();
    closing.close();
  }
  _state = "disconnected";
}

/** A wake signal (tab foregrounded, bfcache restore, network back) is exactly when a
 * half-open socket's lie matters most: `_state` says "connected" whether or not the
 * transport underneath still works, and a phone that just woke is the textbook case
 * (NAT dropped the stream while asleep, no FIN/RST ever arrived). Don't trust it —
 * if it claims connected, probe right now instead of waiting for the next heartbeat
 * tick; the probe's own watchdog forces a reconnect if nothing answers. If it's
 * anything else, skip the probe and reconnect immediately, like the manual Reconnect
 * button — no reason to ride out the accumulated backoff for an obvious fresh wake. */
function handleWake(): void {
  if (intentionalClose) return;
  if (_state !== "connected") {
    forceReconnect();
    return;
  }
  probeLiveness();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    } else {
      handleWake();
    }
  });
  // bfcache restore (e.g. iOS Safari switching apps and back) can land here without
  // ever firing visibilitychange — pageshow is the reliable signal for that case.
  window.addEventListener("pageshow", handleWake);
  // A network flap (cell↔wifi over Tailscale) fires 'online' the moment the OS has
  // connectivity again — usually well before the next backoff tick. Probe/reconnect
  // eagerly instead of riding out the timer.
  window.addEventListener("online", handleWake);
  // Deterministic e2e hook: simulate a transport loss without taking HTTP/Vite
  // offline, so the test can close and reopen the page around a durable queued prompt.
  if (import.meta.env.DEV)
    window.addEventListener("pantoken:test-disconnect", () => disconnect());
  // Deterministic e2e hook: freeze the socket in "reconnecting" (dropped but actively
  // retrying) so a queued prompt renders "Sending when reconnected…". Suppress the real
  // retry/online/visibility auto-reconnect so the state holds for the assertion.
  if (import.meta.env.DEV)
    window.addEventListener("pantoken:test-reconnecting", () => {
      intentionalClose = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        const closing = ws;
        cleanupSocket();
        closing.close();
      }
      _state = "reconnecting";
    });
}

export function onMessage(listener: MessageListener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

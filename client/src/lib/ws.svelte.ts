// Reconnecting WebSocket singleton with reactive Svelte 5 state.
// Ported near-verbatim from KellerComm (frontend/src/lib/ws.svelte.ts), retyped
// to pilot's ClientMessage/ServerMessage envelope.

import {
  type ClientMessage,
  parseServerMessage,
  type ServerMessage,
} from "@pilot/protocol";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

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
let intentionalClose = false;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function getReconnectDelay(): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** _reconnectAttempt, MAX_DELAY_MS);
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

function buildWsUrl(): string {
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

function cleanupSocket(): void {
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
  if (document.visibilityState === "hidden") return;

  const url = buildWsUrl();
  _state = _reconnectAttempt === 0 ? "connecting" : "reconnecting";
  ws = new WebSocket(url);

  ws.onopen = () => {
    _state = "connected";
    _reconnectAttempt = 0;
    send({ type: "hello" });
  };

  ws.onmessage = (event: MessageEvent) => {
    const msg = parseServerMessage(event.data as string);
    if (!msg) return;
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

export function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    } else if (!intentionalClose && _state !== "connected") {
      scheduleReconnect();
    }
  });
}

export function onMessage(listener: MessageListener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

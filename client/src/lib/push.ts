// Web Push subscription: registers this device with the server so a *closed* phone
// can be buzzed. Complements notify.ts (tab-open only). On iOS this only works for a
// PWA installed to the home screen (16.4+), and permission must be requested from a
// user gesture — so ensurePushSubscription() is called from the prompt-send gesture.

import { getToken } from "./auth.js";

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

// Send the token as a Bearer header (not a `?token=` query) so it never lands in a
// URL — keeps it out of history, Referer, and any proxy access log. WS auth already
// uses the hello-message body; this is the HTTP-side equivalent.
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getToken();
  return {
    ...extra,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

// VAPID public keys are base64url; PushManager.subscribe wants a BufferSource.
// Allocate over an explicit ArrayBuffer so the type is ArrayBuffer-backed (not the
// generic ArrayBufferLike, which the DOM lib types reject for applicationServerKey).
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Idempotent: ensure this device has a push subscription registered server-side.
 * Safe to call repeatedly (re-POSTs an existing subscription, which the server
 * dedupes by endpoint). Must run from a user gesture on iOS — it may prompt for
 * notification permission.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (Notification.permission === "denied") return;
      if (Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return;
      }
      const res = await fetch("/push/vapid", { headers: authHeaders() });
      if (!res.ok) return;
      const { publicKey } = (await res.json()) as { publicKey: string };
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await fetch("/push/subscribe", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(sub),
    });
  } catch (e) {
    console.warn("[push] subscription failed", e);
  }
}

/** Dev/verification: ask the server to fan out a test push to all subscriptions. */
export async function sendTestPush(): Promise<void> {
  try {
    const res = await fetch("/push/test", {
      method: "POST",
      headers: authHeaders(),
    });
    console.log("[push] test:", await res.json());
  } catch (e) {
    console.warn("[push] test failed", e);
  }
}

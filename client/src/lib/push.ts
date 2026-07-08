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
// Exported so the base64url→bytes decode (the regression-prone pure part: padding,
// -/_ char mapping, byte copy) is unit-testable without a DOM / PushManager.
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Outcome of a subscribe attempt / status check, so the UI can say what happened
// instead of failing silently (which made the first on-phone test undiagnosable).
export type PushState =
  | "idle" // supported, not yet subscribed
  | "subscribed"
  | "needs-install" // iOS: Web Push only works from a home-screen PWA
  | "denied" // notification permission refused
  | "unsupported"
  | "error";

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS reports as "MacIntel" but is touch-capable
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** True when running as an installed PWA (home screen / standalone), not a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Read current push status without prompting — for initial UI state. */
export async function currentPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (isIOS() && !isStandalone()) return "needs-install";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? "subscribed" : "idle";
  } catch {
    return "idle";
  }
}

/**
 * Idempotent: ensure this device has a push subscription registered server-side,
 * prompting for permission if needed. Returns the outcome so the caller can show it.
 * Must run from a user gesture on iOS, and only works inside an installed PWA there
 * — which is why the prompt-send gesture calls it. One success is memoized for the
 * page's lifetime (the registration is idempotent server-side and the subscription
 * doesn't change under a live page), so subsequent sends skip the
 * serviceWorker.ready + getSubscription + POST /push/subscribe round-trip that
 * otherwise rides every prompt's hot path. Concurrent calls share one attempt.
 */
let subscribedThisPage = false;
let ensureInFlight: Promise<PushState> | null = null;

export function ensurePushSubscription(): Promise<PushState> {
  if (subscribedThisPage) return Promise.resolve("subscribed");
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = ensurePushSubscriptionUncached().finally(() => {
    ensureInFlight = null;
  });
  return ensureInFlight;
}

async function ensurePushSubscriptionUncached(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (isIOS() && !isStandalone()) return "needs-install";
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      if (Notification.permission === "default") {
        if ((await Notification.requestPermission()) !== "granted")
          return "denied";
      } else if (Notification.permission !== "granted") {
        return "denied";
      }
      const res = await fetch("/push/vapid", { headers: authHeaders() });
      if (!res.ok) return "error";
      const { publicKey } = (await res.json()) as { publicKey: string };
      // userVisibleOnly:true is mandatory (Chrome rejects silent subscriptions) and
      // contractually obliges the SW to show a notification for every push. sw.js's
      // push handler deliberately skips the OS notification when a pantoken window is
      // focused/visible to avoid double-buzzing (in-tab notify + terminal agent notify
      // extension fire for the same event). See the trade-off note in sw.js — Chrome
      // may show a generic fallback or penalize the subscription for repeated
      // non-shows; acceptable given pushes are infrequent and event-driven.
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const postRes = await fetch("/push/subscribe", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(sub),
    });
    if (postRes.ok) subscribedThisPage = true;
    return postRes.ok ? "subscribed" : "error";
  } catch (e) {
    console.warn("[push] subscription failed", e);
    return "error";
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

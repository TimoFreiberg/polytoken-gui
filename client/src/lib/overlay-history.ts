// Overlay ↔ browser-history integration for phone-sized viewports. An "overlay" is
// a view that covers the transcript (the sessions drawer, the full-screen context
// view). On a phone, opening one pushes a history entry so the OS back gesture /
// browser back closes the overlay instead of leaving the app — in a standalone PWA
// there is no browser chrome, so back-gesture correctness is the difference between
// "app" and "webpage" feel. Desktop (≥860px) is untouched: opens don't engage the
// history at all (the panels are docked there, not overlays).
//
// Model: one history entry per tracked overlay, kept 1:1 with an internal stack.
// - popstate (back gesture) closes the top overlay.
// - A UI-initiated close (scrim tap, ✕, selecting a session) consumes its entry via
//   history.back() so the stack never accumulates stale overlay entries.
// - An out-of-order UI close (an overlay under the top one) only drops the
//   bookkeeping; its history entry stays and the next back is a harmless no-op pop.
//
// The module is dependency-injected for tests (no jsdom needed); the default env
// binds to the real window lazily and no-ops outside a browser.

/** The app's single phone breakpoint. Must match the 859px used in component CSS. */
export const PHONE_MQ = "(max-width: 859px)";

export interface OverlayHistoryEnv {
  /** Whether overlay↔history coupling applies (phone-sized viewport). */
  isPhone(): boolean;
  pushState(marker: unknown): void;
  back(): void;
  /** Register the popstate listener once; return an unsubscribe. */
  onPop(handler: () => void): () => void;
}

interface Entry {
  id: string;
  close: () => void;
}

export function createOverlayHistory(env: OverlayHistoryEnv) {
  const stack: Entry[] = [];
  let installed = false;
  // Set while we unwind our own history.back() from a UI close: that pop is
  // already accounted for and must not close the (new) top overlay.
  let pendingOwnPops = 0;

  function ensureInstalled(): void {
    if (installed) return;
    installed = true;
    env.onPop(() => {
      if (pendingOwnPops > 0) {
        pendingOwnPops--;
        return;
      }
      const top = stack.pop();
      top?.close();
    });
  }

  return {
    /** An overlay opened. Phone-only; safe to call unconditionally from store actions. */
    opened(id: string, close: () => void): void {
      if (!env.isPhone()) return;
      ensureInstalled();
      // Re-opening an already-tracked overlay (e.g. rapid toggles) must not
      // duplicate its entry — refresh the close callback instead.
      const existing = stack.find((e) => e.id === id);
      if (existing) {
        existing.close = close;
        return;
      }
      stack.push({ id, close });
      env.pushState({ pantokenOverlay: id });
    },
    /** An overlay closed via its own UI (not the back gesture). Consumes the
     *  matching history entry when it's the top one. No-op for untracked ids, so
     *  desktop close paths can call this unconditionally. */
    closed(id: string): void {
      const idx = stack.findIndex((e) => e.id === id);
      if (idx === -1) return;
      const wasTop = idx === stack.length - 1;
      stack.splice(idx, 1);
      if (wasTop) {
        pendingOwnPops++;
        env.back();
      }
      // Out-of-order close: the entry's pop will arrive on a future back and be
      // treated as a real pop; with its bookkeeping gone it closes the then-top
      // overlay — acceptable (one extra back at worst, never an app exit).
    },
    /** Test/introspection hook. */
    depth(): number {
      return stack.length;
    },
  };
}

function browserEnv(): OverlayHistoryEnv {
  return {
    isPhone: () =>
      typeof window !== "undefined" && window.matchMedia(PHONE_MQ).matches,
    pushState: (marker) => history.pushState(marker, "", location.href),
    back: () => history.back(),
    onPop: (handler) => {
      window.addEventListener("popstate", handler);
      return () => window.removeEventListener("popstate", handler);
    },
  };
}

/** App-wide singleton bound to the real browser history. */
export const overlayHistory = createOverlayHistory(browserEnv());

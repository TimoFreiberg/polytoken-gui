// Reactive controller for the left-edge "open the drawer" swipe. Holds the live-follow
// snapshot the Sidebar translates into a `translateX`, and exposes `open`/`cancel` so
// the action's release/cancel callbacks can drive the store without touching it directly.
//
// One instance lives in App.svelte (the swipe surface is `.app`, the main pane); the
// Sidebar receives it as a prop and reacts to `snap` for the follow transform.

import { store } from "./store.svelte.js";
import type { SwipeSnapshot } from "./edge-swipe.js";

const IDLE: SwipeSnapshot = { distance: 0, progress: 0, phase: "idle" };

export function createEdgeSwipe() {
  let snap = $state<SwipeSnapshot>(IDLE);

  return {
    get snap(): SwipeSnapshot {
      return snap;
    },
    onChange(s: SwipeSnapshot): void {
      snap = s;
    },
    /** Release-past-threshold: open the drawer. */
    open(): void {
      snap = IDLE;
      store.openSidebar();
    },
    /** A cancelled swipe (touchcancel) snaps back to idle without opening. */
    cancel(): void {
      snap = IDLE;
    },
  };
}

export type EdgeSwipe = ReturnType<typeof createEdgeSwipe>;

// Reactive controller for a pull-to-refresh surface. Holds the indicator snapshot + the
// "refreshing" flag, and on a fired pull forces a WS reconnect (which re-runs the
// hello→snapshot flow, so the "+ snapshot" half comes for free) and holds the spinner
// until we're connected again. A min-visible floor stops a near-instant reconnect from
// flashing the spinner for a single frame; a max cap stops it sticking forever offline.
// One instance per scroll surface (transcript + sidebar each own theirs).

import { store } from "./store.svelte.js";
import { connectionState } from "./ws.svelte.js";
import type { PullSnapshot } from "./pull-to-refresh.js";

const MIN_VISIBLE_MS = 600;
const MAX_REFRESH_MS = 10_000;

const IDLE: PullSnapshot = { distance: 0, progress: 0, phase: "idle" };

export function createPullRefresh() {
  let snap = $state<PullSnapshot>(IDLE);
  let refreshing = $state(false);
  let poll: ReturnType<typeof setInterval> | null = null;

  function stopPoll(): void {
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  }

  return {
    get snap(): PullSnapshot {
      return snap;
    },
    get refreshing(): boolean {
      return refreshing;
    },
    onChange(s: PullSnapshot): void {
      // Don't let stray late move-events fight the spinner's pinned position.
      if (!refreshing) snap = s;
    },
    /** Release-past-threshold: force reconnect + re-snapshot, hold the spinner until
     *  connected (min-visible) or the max cap elapses. */
    trigger(): void {
      if (refreshing) return;
      refreshing = true;
      snap = IDLE;
      store.reconnect();
      const begin = performance.now();
      stopPoll();
      poll = setInterval(() => {
        const elapsed = performance.now() - begin;
        const settled =
          connectionState() === "connected" && elapsed >= MIN_VISIBLE_MS;
        if (settled || elapsed >= MAX_REFRESH_MS) {
          stopPoll();
          refreshing = false;
        }
      }, 100);
    },
    dispose(): void {
      stopPoll();
    },
  };
}

export type PullRefresh = ReturnType<typeof createPullRefresh>;

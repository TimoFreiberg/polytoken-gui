// Pull-to-refresh: a touch gesture on a scroll container's top edge that triggers a
// refresh (in pantoken: a forced WS reconnect + re-snapshot — "I think this is stale").
// The gesture math lives in a DOM-free `PullTracker` so it's unit-testable; the Svelte
// action wires touch events and reports snapshots back to the component, which owns the
// indicator + the refreshing lifecycle (see `createPullRefresh` in the `.svelte.ts`
// sibling). Touch-only by design: it's the universal *mobile* gesture; desktop already
// has the Reconnect button (Alt+R).

export type PullPhase = "idle" | "pulling" | "armed";

export interface PullSnapshot {
  /** Indicator travel in px (raw drag after resistance, capped at `max`). */
  distance: number;
  /** 0..1 toward the arm threshold (clamped). */
  progress: number;
  phase: PullPhase;
}

export interface PullOptions {
  /** px (post-resistance) the pull must reach to arm a refresh. */
  threshold?: number;
  /** Multiplier on raw drag so the pull feels heavy (rubber-band-ish). */
  resistance?: number;
  /** Cap on indicator travel. */
  max?: number;
}

const DEFAULTS = { threshold: 64, resistance: 0.5, max: 90 };

const IDLE: PullSnapshot = { distance: 0, progress: 0, phase: "idle" };

/** Track a single top-edge pull. DOM-free: fed `(clientY, scrollTop)`, returns snapshots
 *  — so the threshold/resistance logic is exercised by unit tests without a browser. */
export class PullTracker {
  private readonly threshold: number;
  private readonly resistance: number;
  private readonly max: number;
  private engaged = false;
  private startY = 0;
  private snap: PullSnapshot = IDLE;

  constructor(opts: PullOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULTS.threshold;
    this.resistance = opts.resistance ?? DEFAULTS.resistance;
    this.max = opts.max ?? DEFAULTS.max;
  }

  get snapshot(): PullSnapshot {
    return this.snap;
  }

  /** True while a downward pull from the top is live — the caller should
   *  `preventDefault` the move so the browser doesn't also scroll / native-refresh. */
  get active(): boolean {
    return this.engaged && this.snap.distance > 0;
  }

  /** Begin tracking, but only engage if the container is scrolled to the very
   *  top. Returns engagement so the action can attach its non-passive touchmove
   *  listener only for touches that could become a pull. */
  start(clientY: number, scrollTop: number): boolean {
    this.engaged = scrollTop <= 0;
    this.startY = clientY;
    this.snap = IDLE;
    return this.engaged;
  }

  /** Feed a move; returns the new snapshot. A pull that loses the top edge (content
   *  scrolled) or reverses upward collapses back to idle. */
  move(clientY: number, scrollTop: number): PullSnapshot {
    if (!this.engaged || scrollTop > 0) {
      this.engaged = this.engaged && scrollTop <= 0;
      this.snap = IDLE;
      return this.snap;
    }
    const dy = clientY - this.startY;
    if (dy <= 0) {
      this.snap = IDLE;
      return this.snap;
    }
    const distance = Math.min(dy * this.resistance, this.max);
    this.snap = {
      distance,
      progress: Math.min(distance / this.threshold, 1),
      phase: distance >= this.threshold ? "armed" : "pulling",
    };
    return this.snap;
  }

  /** End the pull. Returns whether a refresh should fire, then resets to idle. */
  end(): { triggered: boolean } {
    const triggered = this.engaged && this.snap.phase === "armed";
    this.engaged = false;
    this.snap = IDLE;
    return { triggered };
  }
}

export interface PullActionParams {
  /** Gate the gesture (e.g. touch-primary devices only, and not mid-refresh). */
  enabled: boolean;
  /** Fired on release past the arm threshold. */
  onRefresh: () => void;
  /** Reports every snapshot so the component can drive the indicator. */
  onChange: (snap: PullSnapshot) => void;
  options?: PullOptions;
}

/** Svelte action: wire a scroll container's touch events to a `PullTracker`.
 *
 * The non-passive touchmove listener (needed so `preventDefault` is honored
 * while driving the pull) is attached ONLY while a touch that began at the very
 * top of the scroller is in flight. A permanent non-passive touchmove would
 * force every scroll flick to wait for the main thread before the compositor
 * may move — the transcript is the busiest surface in the app. */
export function pullToRefresh(node: HTMLElement, params: PullActionParams) {
  let p = params;
  const tracker = new PullTracker(p.options);
  let moveBound = false;

  function bindMove(): void {
    if (moveBound) return;
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    moveBound = true;
  }
  function unbindMove(): void {
    if (!moveBound) return;
    node.removeEventListener("touchmove", onTouchMove);
    moveBound = false;
  }

  function onTouchStart(e: TouchEvent): void {
    if (!p.enabled || e.touches.length !== 1) return;
    if (tracker.start(e.touches[0]!.clientY, node.scrollTop)) bindMove();
  }

  function onTouchMove(e: TouchEvent): void {
    if (!p.enabled || e.touches.length !== 1) return;
    const snap = tracker.move(e.touches[0]!.clientY, node.scrollTop);
    // Once a downward pull from the top is live we own the gesture — stop the browser
    // from scroll-chaining or firing its own pull-to-refresh.
    if (tracker.active && e.cancelable) e.preventDefault();
    p.onChange(snap);
  }

  function onTouchEnd(): void {
    unbindMove();
    if (!p.enabled) return;
    const { triggered } = tracker.end();
    p.onChange(tracker.snapshot);
    if (triggered) p.onRefresh();
  }

  node.addEventListener("touchstart", onTouchStart, { passive: true });
  node.addEventListener("touchend", onTouchEnd, { passive: true });
  node.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return {
    update(next: PullActionParams): void {
      p = next;
    },
    destroy(): void {
      node.removeEventListener("touchstart", onTouchStart);
      unbindMove();
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
    },
  };
}

// Edge swipe: a touch gesture that starts within a narrow strip at the screen's left
// edge and drags rightward — the universal mobile "open the drawer" gesture. In pantoken
// it slides the session sidebar in (the phone drawer lives off-screen until opened).
//
// The gesture math lives in a DOM-free `EdgeSwipeTracker` so it's unit-testable; the
// Svelte action wires touch events and reports snapshots back to the component, which
// owns the live-follow transform + the open/close decision (see `createEdgeSwipe` in the
// `.svelte.ts` sibling). Touch-only by design: the sidebar toggle (⌘B) and the header's
// hamburger button are the desktop affordances.

export type SwipePhase = "idle" | "pulling" | "armed";

export interface SwipeSnapshot {
  /** Raw finger travel in px (positive = into the screen from the left edge). */
  distance: number;
  /** 0..1 toward the arm threshold (clamped). */
  progress: number;
  phase: SwipePhase;
}

export interface EdgeSwipeOptions {
  /** px from the left edge where a touch may begin a swipe (inclusive). */
  edge?: number;
  /** px the drag must reach (post-resistance) to arm an open. */
  threshold?: number;
  /** Multiplier on raw drag so the drawer lags the finger a bit (heavier feel). */
  resistance?: number;
  /** Cap on live-follow travel. */
  max?: number;
}

const DEFAULTS = { edge: 24, threshold: 88, resistance: 1, max: 320 };

const IDLE: SwipeSnapshot = { distance: 0, progress: 0, phase: "idle" };

/** Track a single left-edge swipe. DOM-free: fed `(clientX)`, returns snapshots — so the
 *  edge/threshold/resistance logic is exercised by unit tests without a browser. */
export class EdgeSwipeTracker {
  private readonly edge: number;
  private readonly threshold: number;
  private readonly resistance: number;
  private readonly max: number;
  private engaged = false;
  private startX = 0;
  private snap: SwipeSnapshot = IDLE;

  constructor(opts: EdgeSwipeOptions = {}) {
    this.edge = opts.edge ?? DEFAULTS.edge;
    this.threshold = opts.threshold ?? DEFAULTS.threshold;
    this.resistance = opts.resistance ?? DEFAULTS.resistance;
    this.max = opts.max ?? DEFAULTS.max;
  }

  get snapshot(): SwipeSnapshot {
    return this.snap;
  }

  /** True while a left-edge swipe is live and dragging in — the caller should
   *  `preventDefault` the move so the browser doesn't also scroll/pan. */
  get active(): boolean {
    return this.engaged && this.snap.distance > 0;
  }

  /** Begin tracking, but only engage if the touch started inside the left edge
   *  strip. Returns engagement so the action can attach its non-passive
   *  touchmove listener only for touches that could become a swipe. */
  start(clientX: number): boolean {
    this.engaged = clientX <= this.edge;
    this.startX = clientX;
    this.snap = IDLE;
    return this.engaged;
  }

  /** Feed a move; returns the new snapshot. A drag that reverses back out of the screen
   *  (clientX < startX) collapses to idle. */
  move(clientX: number): SwipeSnapshot {
    if (!this.engaged) {
      this.snap = IDLE;
      return this.snap;
    }
    const dx = clientX - this.startX;
    if (dx <= 0) {
      this.snap = IDLE;
      return this.snap;
    }
    const distance = Math.min(dx * this.resistance, this.max);
    this.snap = {
      distance,
      progress: Math.min(distance / this.threshold, 1),
      phase: distance >= this.threshold ? "armed" : "pulling",
    };
    return this.snap;
  }

  /** End the swipe. Returns whether an open should fire, then resets to idle. */
  end(): { triggered: boolean } {
    const triggered = this.engaged && this.snap.phase === "armed";
    this.engaged = false;
    this.snap = IDLE;
    return { triggered };
  }

  /** Forcibly cancel an in-flight swipe (e.g. a touchcancel) without firing. */
  cancel(): void {
    this.engaged = false;
    this.snap = IDLE;
  }
}

export interface EdgeSwipeActionParams {
  /** Gate the gesture — phone-only, and not when the drawer is already open. */
  enabled: boolean;
  /** Fired on release past the arm threshold. */
  onOpen: () => void;
  /** Reports every snapshot so the component can drive the live-follow transform. */
  onChange: (snap: SwipeSnapshot) => void;
  /** Fired when a live swipe is cancelled (touchcancel) so the component can snap back. */
  onCancel?: () => void;
  options?: EdgeSwipeOptions;
}

/** Svelte action: wire a surface's touch events to an `EdgeSwipeTracker`.
 *
 * The non-passive touchmove listener (needed so `preventDefault` is honored
 * while driving the swipe) is attached ONLY while a touch that began in the
 * edge strip is in flight. A permanent non-passive touchmove would force every
 * scroll flick on this surface to wait for the main thread before the
 * compositor may move — exactly the jank a busy streaming turn produces. */
export function edgeSwipe(node: HTMLElement, params: EdgeSwipeActionParams) {
  let p = params;
  const tracker = new EdgeSwipeTracker(p.options);
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
    if (tracker.start(e.touches[0]!.clientX)) bindMove();
  }

  function onTouchMove(e: TouchEvent): void {
    if (!p.enabled || e.touches.length !== 1) return;
    const snap = tracker.move(e.touches[0]!.clientX);
    // Once a left-edge swipe is live we own the gesture — stop the browser from
    // scroll-chaining, firing back/forward nav, or pull-to-refresh underneath us.
    if (tracker.active && e.cancelable) e.preventDefault();
    p.onChange(snap);
  }

  function onTouchEnd(): void {
    unbindMove();
    if (!p.enabled) return;
    const { triggered } = tracker.end();
    p.onChange(tracker.snapshot);
    if (triggered) p.onOpen();
  }

  function onTouchCancel(): void {
    unbindMove();
    if (!p.enabled) return;
    tracker.cancel();
    p.onChange(tracker.snapshot);
    p.onCancel?.();
  }

  node.addEventListener("touchstart", onTouchStart, { passive: true });
  node.addEventListener("touchend", onTouchEnd, { passive: true });
  node.addEventListener("touchcancel", onTouchCancel, { passive: true });

  return {
    update(next: EdgeSwipeActionParams): void {
      p = next;
    },
    destroy(): void {
      node.removeEventListener("touchstart", onTouchStart);
      unbindMove();
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchCancel);
    },
  };
}

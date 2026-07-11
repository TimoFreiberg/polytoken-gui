import { describe, expect, test } from "bun:test";
import {
  createOverlayHistory,
  type OverlayHistoryEnv,
} from "./overlay-history.js";

// A fake browser history: pushState appends, back() pops and (like the real thing)
// delivers the popstate asynchronously-in-order — here synchronously right away,
// which is the stricter ordering for the double-close guard.
function fakeEnv(opts?: { phone?: boolean }) {
  let popHandler: (() => void) | null = null;
  const log: string[] = [];
  let entries = 0;
  const env: OverlayHistoryEnv = {
    isPhone: () => opts?.phone !== false,
    pushState: () => {
      entries++;
      log.push("push");
    },
    back: () => {
      entries--;
      log.push("back");
      popHandler?.();
    },
    onPop: (h) => {
      popHandler = h;
      return () => (popHandler = null);
    },
  };
  return {
    env,
    log,
    entryCount: () => entries,
    // Simulate a user back gesture: the browser pops the entry, then fires popstate.
    userBack: () => {
      entries--;
      log.push("user-back");
      popHandler?.();
    },
  };
}

describe("overlay history", () => {
  test("open pushes one entry; back gesture closes the overlay", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    let open = true;
    oh.opened("ctx", () => (open = false));
    expect(f.entryCount()).toBe(1);
    f.userBack();
    expect(open).toBe(false);
    expect(oh.depth()).toBe(0);
    expect(f.entryCount()).toBe(0);
  });

  test("UI close consumes the pushed entry without re-closing", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    let closes = 0;
    oh.opened("ctx", () => closes++);
    oh.closed("ctx"); // scrim tap / ✕ — store already set its state closed
    expect(f.entryCount()).toBe(0);
    expect(oh.depth()).toBe(0);
    // Our own back() must not invoke the close callback again.
    expect(closes).toBe(0);
  });

  test("open → UI close → open → back gesture: second entry works", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    let open = false;
    oh.opened("ctx", () => (open = false));
    oh.closed("ctx");
    open = true;
    oh.opened("ctx", () => (open = false));
    expect(f.entryCount()).toBe(1);
    f.userBack();
    expect(open).toBe(false);
    expect(f.entryCount()).toBe(0);
  });

  test("stacked overlays close top-first on back gestures", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    const closed: string[] = [];
    oh.opened("drawer", () => closed.push("drawer"));
    oh.opened("ctx", () => closed.push("ctx"));
    expect(f.entryCount()).toBe(2);
    f.userBack();
    f.userBack();
    expect(closed).toEqual(["ctx", "drawer"]);
    expect(f.entryCount()).toBe(0);
  });

  test("re-opening a tracked overlay does not duplicate its entry", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    oh.opened("drawer", () => {});
    oh.opened("drawer", () => {});
    expect(f.entryCount()).toBe(1);
    expect(oh.depth()).toBe(1);
  });

  test("closing an untracked id is a no-op (desktop close paths)", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    oh.closed("ctx");
    expect(f.log).toEqual([]);
  });

  test("desktop viewport never engages the history", () => {
    const f = fakeEnv({ phone: false });
    const oh = createOverlayHistory(f.env);
    oh.opened("ctx", () => {});
    oh.closed("ctx");
    expect(f.log).toEqual([]);
    expect(oh.depth()).toBe(0);
  });

  test("out-of-order UI close drops bookkeeping but keeps the top overlay backed", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    const closed: string[] = [];
    oh.opened("drawer", () => closed.push("drawer"));
    oh.opened("ctx", () => closed.push("ctx"));
    oh.closed("drawer"); // closed under the top — entry stays (2 pushed, 0 backed)
    expect(oh.depth()).toBe(1);
    f.userBack(); // closes ctx (the top)
    expect(closed).toEqual(["ctx"]);
    f.userBack(); // stale drawer entry — harmless no-op pop
    expect(closed).toEqual(["ctx"]);
  });
});

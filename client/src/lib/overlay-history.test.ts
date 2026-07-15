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
    replaceState: () => log.push("replace"),
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

  test("an open waits for an asynchronous UI-close Back to finish", () => {
    let popHandler: (() => void) | null = null;
    const log: string[] = [];
    const oh = createOverlayHistory({
      isPhone: () => true,
      pushState: () => log.push("push"),
      replaceState: () => log.push("replace"),
      back: () => log.push("back"),
      onPop: (handler) => {
        popHandler = handler;
        return () => (popHandler = null);
      },
    });
    let attentionOpen = true;
    oh.opened("sidebar", () => {});
    oh.closed("sidebar");
    oh.opened("attention", () => (attentionOpen = false));
    expect(log).toEqual(["push", "back"]);
    expect(oh.depth()).toBe(1);
    (popHandler as (() => void) | null)?.();
    expect(log).toEqual(["push", "back", "push"]);
    (popHandler as (() => void) | null)?.();
    expect(attentionOpen).toBe(false);
  });

  test("switching phone views reuses one entry and back returns to transcript", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    const closed: string[] = [];
    oh.opened("drawer", () => closed.push("drawer"));
    oh.opened("ctx", () => closed.push("ctx"));
    expect(f.entryCount()).toBe(1);
    expect(f.log).toEqual(["push", "replace"]);
    expect(closed).toEqual(["drawer"]);
    f.userBack();
    expect(closed).toEqual(["drawer", "ctx"]);
    expect(f.entryCount()).toBe(0);
  });

  test("nested surface gets its own entry and back reveals its parent", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    const closed: string[] = [];
    oh.opened("sessions", () => closed.push("sessions"));
    oh.openedNested("session-actions", () => closed.push("actions"));
    expect(f.entryCount()).toBe(2);
    expect(oh.depth()).toBe(2);
    f.userBack();
    expect(closed).toEqual(["actions"]);
    expect(oh.depth()).toBe(1);
    f.userBack();
    expect(closed).toEqual(["actions", "sessions"]);
  });

  test("UI-closing a nested surface consumes only its own entry", () => {
    const f = fakeEnv();
    const oh = createOverlayHistory(f.env);
    let parentOpen = true;
    oh.opened("sessions", () => (parentOpen = false));
    oh.openedNested("session-actions", () => {});
    oh.closed("session-actions");
    expect(f.entryCount()).toBe(1);
    expect(oh.depth()).toBe(1);
    expect(parentOpen).toBe(true);
    f.userBack();
    expect(parentOpen).toBe(false);
  });

  test("reopening a nested surface waits for its UI-close Back to finish", () => {
    let popHandler: (() => void) | null = null;
    const log: string[] = [];
    const oh = createOverlayHistory({
      isPhone: () => true,
      pushState: () => log.push("push"),
      replaceState: () => log.push("replace"),
      back: () => log.push("back"),
      onPop: (handler) => {
        popHandler = handler;
        return () => (popHandler = null);
      },
    });
    let reopened = true;
    oh.opened("sessions", () => {});
    oh.openedNested("session-actions", () => {});
    oh.closed("session-actions");
    oh.openedNested("session-actions", () => (reopened = false));
    expect(log).toEqual(["push", "push", "back"]);
    expect(oh.depth()).toBe(2);

    (popHandler as (() => void) | null)?.();
    expect(log).toEqual(["push", "push", "back", "push"]);
    (popHandler as (() => void) | null)?.();
    expect(reopened).toBe(false);
    expect(oh.depth()).toBe(1);
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
});

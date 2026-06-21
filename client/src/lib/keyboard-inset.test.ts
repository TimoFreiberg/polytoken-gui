import { describe, expect, test } from "bun:test";
import { keyboardInset, trackKeyboardInset } from "./keyboard-inset.js";

describe("keyboardInset", () => {
  test("no keyboard (visual == layout) is zero", () => {
    expect(keyboardInset({ innerHeight: 800, height: 800, offsetTop: 0 })).toBe(
      0,
    );
  });

  test("an open keyboard is the shrunk-viewport difference", () => {
    expect(keyboardInset({ innerHeight: 800, height: 500, offsetTop: 0 })).toBe(
      300,
    );
  });

  test("a scrolled-under page subtracts the visual offsetTop too", () => {
    expect(
      keyboardInset({ innerHeight: 800, height: 500, offsetTop: 100 }),
    ).toBe(200);
  });

  test("a larger visual viewport (URL-bar reflow) clamps to 0, never negative", () => {
    expect(keyboardInset({ innerHeight: 800, height: 820, offsetTop: 0 })).toBe(
      0,
    );
  });

  test("rounds sub-pixel jitter", () => {
    expect(
      keyboardInset({ innerHeight: 800.4, height: 500.1, offsetTop: 0 }),
    ).toBe(300);
  });
});

describe("trackKeyboardInset", () => {
  // Minimal fakes — enough surface for the tracker to read metrics and (un)subscribe.
  function fakeWin(vvOpts?: { height: number; offsetTop: number }) {
    const props: Record<string, string> = {};
    const listeners: Record<string, (() => void)[]> = {};
    const vv = vvOpts
      ? {
          height: vvOpts.height,
          offsetTop: vvOpts.offsetTop,
          addEventListener: (ev: string, fn: () => void) => {
            (listeners[ev] ??= []).push(fn);
          },
          removeEventListener: (ev: string, fn: () => void) => {
            listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
          },
        }
      : undefined;
    const win = {
      innerHeight: 800,
      visualViewport: vv,
      document: {
        documentElement: {
          style: {
            setProperty: (k: string, v: string) => {
              props[k] = v;
            },
            removeProperty: (k: string) => {
              delete props[k];
            },
          },
        },
      },
    } as unknown as Window;
    return { win, props, listeners };
  }

  test("publishes the inset immediately and on viewport resize", () => {
    const { win, props, listeners } = fakeWin({ height: 800, offsetTop: 0 });
    const stop = trackKeyboardInset(win);
    expect(props["--keyboard-inset"]).toBe("0px");

    // Keyboard opens: shrink the visual viewport and fire resize.
    (win.visualViewport as unknown as { height: number }).height = 540;
    listeners.resize?.forEach((fn) => fn());
    expect(props["--keyboard-inset"]).toBe("260px");

    stop();
    expect(props["--keyboard-inset"]).toBeUndefined();
  });

  test("is a no-op without a visualViewport", () => {
    const { win, props } = fakeWin();
    const stop = trackKeyboardInset(win);
    expect(props["--keyboard-inset"]).toBeUndefined();
    expect(() => stop()).not.toThrow();
  });
});

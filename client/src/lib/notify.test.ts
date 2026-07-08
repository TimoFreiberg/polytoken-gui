import { describe, expect, test } from "bun:test";
import { shouldNotify } from "./notify.js";

// Focus-based gating (Part A): notify whenever pantoken isn't the focused window —
// including a desktop window that's visible but not the active OS window. The pure
// predicate is the testable core; notifyIfUnfocused just feeds it document.hasFocus().
describe("shouldNotify", () => {
  const ok = {
    supported: true,
    permission: "granted" as const,
    focused: false,
  };

  test("fires when supported, granted, and unfocused", () => {
    // focused:false also covers the desktop "visible but another app is active" case —
    // the predicate deliberately doesn't look at visibility, only focus.
    expect(shouldNotify(ok)).toBe(true);
  });

  test("stays quiet while pantoken has focus", () => {
    expect(shouldNotify({ ...ok, focused: true })).toBe(false);
  });

  test("stays quiet without granted permission", () => {
    expect(shouldNotify({ ...ok, permission: "default" })).toBe(false);
    expect(shouldNotify({ ...ok, permission: "denied" })).toBe(false);
  });

  test("stays quiet when notifications are unsupported", () => {
    expect(shouldNotify({ ...ok, supported: false })).toBe(false);
  });
});

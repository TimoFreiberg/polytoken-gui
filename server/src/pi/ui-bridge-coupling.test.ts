// pi-version canary for the `qna` unwrapped-bridge coupling (review Rec #6).
//
// pilot's `PiUiBridge.qna()` is a purpose-built multi-question form that is NOT part
// of pi's typed `ExtensionUIContext` (see ui-bridge.ts comment ~line 182). It is only
// reachable because pi hands extensions the RAW, UNWRAPPED bridge as `ctx.ui` (the
// runner returns `uiContext` as-is), so methods beyond the typed interface are still
// callable. This is a coupling to an UNDOCUMENTED pi-internal behavior.
//
// If pi ever wraps `ctx.ui`, or adds/renames methods, `qna` silently degrades — the
// answer extension feature-detects and falls back, but a non-answer extension relying
// on the same trick would break invisibly. This test makes the coupling LOUD:
//
//   - `qna is NOT on pi's ExtensionUIContext` is the compile-time canary. If pi ever
//     ADDS `qna` to the typed interface, this flips to a type error here (the cast in
//     pi-driver.ts would then be unnecessary, or the semantics would change) — surfacing
//     the drift before a silent degradation.
//   - `PiUiBridge exposes qna` is the runtime half: asserts the method the raw bridge
//     relies on actually exists on our bridge object.
//
// This is the one dependency on undocumented pi-internal behavior in the codebase; the
// risk is tracked in docs/DECISIONS.md (D13 / tracked risks) alongside the branch
// durability gap.

import { describe, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "@pilot/protocol";
import { PiUiBridge } from "./ui-bridge.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };

describe("qna unwrapped-bridge coupling canary (Rec #6)", () => {
  test("qna is NOT part of pi's typed ExtensionUIContext (the whole reason for the raw-bridge trick)", () => {
    // Compile-time canary: `qna` must NOT exist on pi's ExtensionUIContext type.
    // If a pi version bump adds it, this `extends` flips to false and the test fails
    // LOUD — flagging that the unwrapped-bridge cast in pi-driver.ts needs a revisit
    // (it may now be redundant, or the typed path may carry different semantics).
    type HasQna = "qna" extends keyof ExtensionUIContext ? true : false;
    const qnaOnTypedInterface: HasQna = false;
    expect(qnaOnTypedInterface).toBe(false);

    // The methods pilot's bridge DOES implement as typed ExtensionUIContext members —
    // listed so a rename/removal in pi also fails loud here. Compile-time: each must
    // be a key of the interface (types are erased at runtime, so check at the type level,
    // not with `in` on an object literal).
    const requiredTypedMethods = [
      "select",
      "confirm",
      "input",
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "editor",
      "custom",
    ] as const;
    for (const m of requiredTypedMethods) {
      type IsKey = typeof m extends keyof ExtensionUIContext ? true : false;
      const isKey: IsKey = true;
      expect(isKey).toBe(true);
    }
  });

  test("PiUiBridge exposes qna (reachable via the raw unwrapped ctx.ui)", () => {
    const events: unknown[] = [];
    const bridge = new PiUiBridge(
      ref,
      (e) => events.push(e),
      () => "t0",
    );
    // qna is a real own method on the bridge — the thing pi would call through the
    // raw ctx.ui. NOT on ExtensionUIContext (see the test above), so it only works
    // because pi hands extensions the unwrapped bridge.
    expect(typeof bridge.qna).toBe("function");
  });
});

// isPilotOwnedExtension is the SHARED client+server predicate for "is this name a
// pilot-OWNED extension?" Used by the Settings UI (flag owned rows + route toggles to
// enabledExtensions) and the server (route the toggle). A regression (broken .ts
// stripping, wrong membership) would make the two disagree on what counts as owned —
// the UI would route a toggle to the wrong path. Pure; pins the name-only contract the
// header documents (it does NOT verify path identity — a user's own session-namer.ts
// on disk also matches, by design).

import { describe, expect, test } from "bun:test";
import {
  PILOT_OWNED_EXTENSION_NAMES,
  isPilotOwnedExtension,
} from "./pilot-extensions.js";

describe("isPilotOwnedExtension", () => {
  test("true for each owned basename", () => {
    for (const name of PILOT_OWNED_EXTENSION_NAMES) {
      expect(isPilotOwnedExtension(name)).toBe(true);
    }
  });

  test("true for a name WITH a trailing .ts (the Settings/fixture row shape)", () => {
    // The list stores bare basenames; the predicate must accept the `name.ts` form the
    // UI/rows carry. A naive `includes(name)` without the strip would miss these.
    expect(isPilotOwnedExtension("session-namer.ts")).toBe(true);
    expect(isPilotOwnedExtension("tasklist.ts")).toBe(true);
    expect(isPilotOwnedExtension("answer.ts")).toBe(true);
  });

  test("false for a non-owned name", () => {
    expect(isPilotOwnedExtension("someone-elses-ext")).toBe(false);
    expect(isPilotOwnedExtension("session-namer.js")).toBe(false); // wrong ext, not stripped
    expect(isPilotOwnedExtension("")).toBe(false);
  });

  test("name-only match: a same-named user extension also matches (documented footgun)", () => {
    // The header's NOTE: this keys off NAME only, not path identity. A user's own
    // session-namer.ts on disk matches here too. Pin that behavior so a future "fix"
    // (adding path checks) is a deliberate change, not a silent one — the server's
    // path-equality reverse lookup (ownedExtensionBasename) is where path identity
    // matters, not here.
    expect(isPilotOwnedExtension("session-namer")).toBe(true); // name collides with owned
  });

  test("the owned list is readonly + contains exactly the three known extensions", () => {
    // A guard against accidentally adding/removing an entry without updating the three
    // load sites. If a new pilot extension ships, this forces the test update in the same
    // chunk (the header's "add a name here in the same chunk" contract).
    expect([...PILOT_OWNED_EXTENSION_NAMES].sort()).toEqual([
      "answer",
      "session-namer",
      "tasklist",
    ]);
  });
});

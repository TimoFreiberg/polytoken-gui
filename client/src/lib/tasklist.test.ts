import { describe, expect, test } from "bun:test";
import { parseTasklist } from "./tasklist.js";

describe("parseTasklist", () => {
  test("parses the extension's real format (header + ○ items, no #id)", () => {
    // the widget item lines are `  ○ description` — the `#id` is internal-only.
    const lines = [
      "Open Tasks (3):",
      "  ○ first item",
      "  ○ item numero dos",
      "  ○ and a third, why not",
    ];
    expect(parseTasklist(lines)).toEqual([
      { description: "first item" },
      { description: "item numero dos" },
      { description: "and a third, why not" },
    ]);
  });

  test("ignores the header line, keeps only items", () => {
    const parsed = parseTasklist(["Open Tasks (1):", "  ○ solo"]);
    expect(parsed).toEqual([{ description: "solo" }]);
  });

  test("keeps colons inside the description", () => {
    const parsed = parseTasklist(["  ○ fix foo: the bar case"]);
    expect(parsed).toEqual([{ description: "fix foo: the bar case" }]);
  });

  test("tolerates the ASCII stand-in glyphs and no leading indent", () => {
    // The regex accepts ○ ◯ o * - as the item glyph (the extension emits ○; the others
    // are defensive stand-ins). No `#` prefix on the (now-absent) id.
    expect(parseTasklist(["  * plain star item"])).toEqual([
      { description: "plain star item" },
    ]);
    expect(parseTasklist(["- dash item"])).toEqual([
      { description: "dash item" },
    ]);
  });

  test("ignores a stray id-looking token as part of the description", () => {
    // A legacy line still carrying `#v23gry: …` (an old extension / a different host)
    // no longer splits id from description — the whole tail is the description now. This
    // documents the parser simplification: there is no id to capture.
    const parsed = parseTasklist(["  ○ #v23gry: fix foo"]);
    expect(parsed).toEqual([{ description: "#v23gry: fix foo" }]);
  });

  test("skips blank descriptions (a lone glyph with nothing after)", () => {
    expect(parseTasklist(["  ○", "  ○ real one"])).toEqual([
      { description: "real one" },
    ]);
  });

  test("returns null when nothing parses (empty or unrecognized)", () => {
    expect(parseTasklist([])).toBeNull();
    expect(parseTasklist(undefined)).toBeNull();
    expect(parseTasklist(["Open Tasks (0):"])).toBeNull();
    expect(
      parseTasklist(["some unrelated widget", "no items here"]),
    ).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import type { FileInfo } from "@pantoken/protocol";
import { extractAtQuery, filterFiles } from "./file-autocomplete.js";

describe("extractAtQuery", () => {
  test("returns the text after @ at cursor position", () => {
    const r = extractAtQuery("hello @file.ts", 14);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("file.ts");
    expect(r!.atPos).toBe(6);
  });

  test("empty query when @ is just typed", () => {
    const r = extractAtQuery("@", 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
    expect(r!.atPos).toBe(0);
  });

  test("returns null when there is no @", () => {
    expect(extractAtQuery("hello world", 5)).toBeNull();
  });

  test("returns null for email-like @ (embedded in a word)", () => {
    expect(extractAtQuery("email@domain.com", 13)).toBeNull();
  });

  test("@ at a token boundary (after space) is valid", () => {
    const r = extractAtQuery("review @src/foo", 15);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src/foo");
    expect(r!.atPos).toBe(7);
  });

  test("@ after comma is a token boundary", () => {
    const r = extractAtQuery("check,@test", 11);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("test");
  });

  test("returns only the active token, not a later @", () => {
    // "@one some @two" with cursor right after "@one" (pos 4, before the space)
    // → query is just "one"; the later @two is irrelevant.
    const r = extractAtQuery("@one some @two", 4);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("one");
    expect(r!.atPos).toBe(0);
  });

  test("whitespace inside the token closes the mention", () => {
    // Cursor past a space after the mention ("@one some|") — the mention ended
    // at the space, so this is plain prose, not an active mention. Guards the
    // runaway-fd bug: without this, every word typed after a mention re-queries.
    expect(extractAtQuery("@one some", 9)).toBeNull();
    expect(extractAtQuery("@README.md explain", 18)).toBeNull();
  });

  test("cursor before the @ returns null", () => {
    expect(extractAtQuery("before @after", 3)).toBeNull();
  });

  test("whitespace after @ closes the token (not a mention)", () => {
    expect(extractAtQuery("@ ", 2)).toBeNull();
    expect(extractAtQuery("@\t", 2)).toBeNull();
  });

  test("slash mode at position 0 suppresses @ at the start", () => {
    // "/@foo" with cursor at 5 — slash takes priority
    expect(extractAtQuery("/@foo", 5)).toBeNull();
  });

  test("@ after slash-command arg is valid", () => {
    // "/review @src" with cursor at 13 — slash settled, @ is file mention
    const r = extractAtQuery("/review @src", 13);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src");
    expect(r!.atPos).toBe(8);
  });

  test("cursor at the exact @ position returns empty query", () => {
    const r = extractAtQuery("@", 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
  });

  test("partial typing after @ works", () => {
    const r = extractAtQuery("check @serv", 11);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("serv");
    expect(r!.atPos).toBe(6);
  });

  test("empty draft returns null", () => {
    expect(extractAtQuery("", 0)).toBeNull();
  });

  test("cursor clamped to draft length", () => {
    const r = extractAtQuery("@file", 999);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("file");
  });
});

describe("filterFiles", () => {
  const f = (path: string, isDirectory = false): FileInfo => ({
    path,
    isDirectory,
  });
  const FILES: readonly FileInfo[] = [
    f("README.md"),
    f("store", true),
    f("store.ts"),
    f("lib/mystore.ts"),
    f("server", true),
    f("server/src/hub.ts"),
    f("docs/DESIGN.md"),
  ];
  const paths = (items: FileInfo[]) => items.map((i) => i.path);

  test("empty query returns the head of the index (bare @)", () => {
    expect(paths(filterFiles(FILES, "", 3))).toEqual([
      "README.md",
      "store",
      "store.ts",
    ]);
  });

  test("substring match drops non-matches", () => {
    expect(paths(filterFiles(FILES, "hub"))).toEqual(["server/src/hub.ts"]);
  });

  test("match is case-insensitive", () => {
    expect(paths(filterFiles(FILES, "HUB"))).toEqual(["server/src/hub.ts"]);
  });

  test("ranks basename-prefix > path-prefix > interior, dir before file on ties", () => {
    // "store": dir + file both basename-prefix (dir first), then the interior match.
    expect(paths(filterFiles(FILES, "store"))).toEqual([
      "store", // basename-prefix, directory → first
      "store.ts", // basename-prefix, file
      "lib/mystore.ts", // interior match → last
    ]);
  });

  test("path-prefix outranks an interior match", () => {
    const files = [f("lib/observer.ts"), f("server/src/hub.ts")];
    // "server": path-prefix on the second; interior (inside "observer") on the first.
    expect(paths(filterFiles(files, "server"))).toEqual([
      "server/src/hub.ts",
      "lib/observer.ts",
    ]);
  });

  test("respects the limit", () => {
    expect(filterFiles(FILES, "", 2)).toHaveLength(2);
    const manyTs = [f("a.ts"), f("b.ts"), f("c.ts"), f("d.ts")];
    expect(filterFiles(manyTs, ".ts", 2)).toHaveLength(2);
  });

  test("no match returns empty", () => {
    expect(filterFiles(FILES, "zzz")).toEqual([]);
  });
});

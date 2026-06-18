import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveStore } from "./archive-store.js";

describe("ArchiveStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pilot-archive-"));
    file = join(dir, "archived.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("has() is false for an unknown path", () => {
    expect(new ArchiveStore(file).has("/a.jsonl")).toBe(false);
  });

  test("set(true) archives, set(false) unarchives", () => {
    const s = new ArchiveStore(file);
    s.set("/a.jsonl", true);
    expect(s.has("/a.jsonl")).toBe(true);
    s.set("/a.jsonl", false);
    expect(s.has("/a.jsonl")).toBe(false);
  });

  test("persists across instances — the file is the source of truth", () => {
    const s1 = new ArchiveStore(file);
    s1.set("/a.jsonl", true);
    s1.set("/b.jsonl", true);
    const s2 = new ArchiveStore(file);
    expect(s2.has("/a.jsonl")).toBe(true);
    expect(s2.has("/b.jsonl")).toBe(true);
    expect(s2.has("/c.jsonl")).toBe(false);
  });

  test("unarchiving removes the path from the persisted set", () => {
    const s1 = new ArchiveStore(file);
    s1.set("/a.jsonl", true);
    s1.set("/a.jsonl", false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
    expect(new ArchiveStore(file).has("/a.jsonl")).toBe(false);
  });

  test("a missing index file loads as empty, not an error", () => {
    expect(new ArchiveStore(join(dir, "nope.json")).has("/a.jsonl")).toBe(
      false,
    );
  });
});

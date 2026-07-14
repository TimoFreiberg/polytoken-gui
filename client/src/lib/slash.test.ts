import { describe, expect, test } from "bun:test";
import type { CommandInfo } from "@pantoken/protocol";
import { filterCommands, parseSlashCommand, slashQuery } from "./slash.js";

const CMDS: CommandInfo[] = [
  { name: "review", source: "prompt", argumentHint: "[path]" },
  { name: "plan", source: "prompt" },
  { name: "pr", source: "extension" },
  { name: "core-review", source: "extension" },
  { name: "skill:debug", source: "skill" },
];

describe("slashQuery", () => {
  test("returns the text after a leading slash with no whitespace", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/skill:de")).toBe("skill:de");
  });

  test("is inactive once the name is settled or the draft isn't a slash token", () => {
    expect(slashQuery("/review src")).toBeNull(); // space → typing args now
    expect(slashQuery("/review\n")).toBeNull(); // newline counts as whitespace
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("")).toBeNull();
    expect(slashQuery(" /review")).toBeNull(); // leading space, not a command
  });
});

describe("filterCommands", () => {
  test("empty query returns every command, alphabetical", () => {
    expect(filterCommands(CMDS, "").map((c) => c.name)).toEqual([
      "core-review",
      "plan",
      "pr",
      "review",
      "skill:debug",
    ]);
  });

  test("prefix matches rank above interior matches", () => {
    // "review" (prefix) before "core-review" (interior)
    expect(filterCommands(CMDS, "review").map((c) => c.name)).toEqual([
      "review",
      "core-review",
    ]);
  });

  test("is case-insensitive and matches interior substrings", () => {
    expect(filterCommands(CMDS, "DEBUG").map((c) => c.name)).toEqual([
      "skill:debug",
    ]);
  });

  test("prefix group is sorted alphabetically among ties", () => {
    // "p" prefixes: "plan", "pr" → alphabetical
    expect(filterCommands(CMDS, "p").map((c) => c.name)).toEqual([
      "plan",
      "pr",
    ]);
  });

  test("no match yields an empty list", () => {
    expect(filterCommands(CMDS, "zzz")).toEqual([]);
  });
});

describe("parseSlashCommand", () => {
  test("extracts a bare command name with no args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
  });

  test("extracts a command name and args", () => {
    expect(parseSlashCommand("/compact summary text")).toEqual({
      name: "compact",
      args: "summary text",
    });
  });

  test("extracts a namespaced command name", () => {
    expect(parseSlashCommand("/skill:debug")).toEqual({
      name: "skill:debug",
      args: "",
    });
  });

  test("extracts args that look like file paths", () => {
    expect(parseSlashCommand("/review src/foo.ts")).toEqual({
      name: "review",
      args: "src/foo.ts",
    });
  });

  test("returns null for non-slash text", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  test("trims leading whitespace before checking for a slash", () => {
    expect(parseSlashCommand("  /clear")).toEqual({
      name: "clear",
      args: "",
    });
  });

  test("returns null for a bare slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });

  test("returns null when a space immediately follows the slash", () => {
    expect(parseSlashCommand("/ foo")).toBeNull();
  });
});

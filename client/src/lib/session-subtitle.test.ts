import { describe, expect, test } from "bun:test";
import { sessionSubtitle } from "./session-subtitle.js";

describe("sessionSubtitle", () => {
  test("plain session → project name (cwd basename)", () => {
    expect(sessionSubtitle({ cwd: "/Users/timo/src/pantoken" })).toBe("pantoken");
  });

  test("trailing slashes are ignored", () => {
    expect(sessionSubtitle({ cwd: "/Users/timo/src/pantoken/" })).toBe("pantoken");
  });

  test("worktree session → project · worktree dir", () => {
    expect(
      sessionSubtitle({
        cwd: "/Users/timo/.cache/worktrees/nervous-kilby",
        worktreeBase: "/Users/timo/src/pantoken",
      }),
    ).toBe("pantoken · nervous-kilby");
  });

  test("degenerate worktree (cwd basename == project) drops the suffix", () => {
    expect(sessionSubtitle({ cwd: "/a/pantoken", worktreeBase: "/b/pantoken" })).toBe(
      "pantoken",
    );
  });

  test("no cwd → 'no session'", () => {
    expect(sessionSubtitle({})).toBe("no session");
    expect(sessionSubtitle({ cwd: "" })).toBe("no session");
  });
});

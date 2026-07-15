import { describe, expect, test } from "bun:test";
import {
  completeDirectoryInput,
  rankDirectoryMatches,
  splitDirectoryInput,
} from "./directory-picker.js";

describe("directory picker path model", () => {
  test("splits absolute, home-relative, relative, and current-directory paths", () => {
    expect(splitDirectoryInput("/Users/timo/sr")).toEqual({
      browsePath: "/Users/timo",
      leaf: "sr",
      viewingDirectory: false,
    });
    expect(splitDirectoryInput("~/sr").browsePath).toBe("~");
    expect(splitDirectoryInput("src").browsePath).toBe(".");
    expect(splitDirectoryInput("/Users/timo/src/").viewingDirectory).toBe(true);
  });

  test("completion preserves the path spelling and adds a directory separator", () => {
    expect(completeDirectoryInput("/Users/timo/sr", "src")).toBe(
      "/Users/timo/src/",
    );
    expect(completeDirectoryInput("~/sr", "src")).toBe("~/src/");
    expect(completeDirectoryInput("sr", "src")).toBe("src/");
  });

  test("stable prefix matches rank ahead of fuzzy matches", () => {
    expect(rankDirectoryMatches(["server", "src", "scratch"], "sr")).toEqual([
      { name: "src", prefix: true },
      { name: "server", prefix: false },
      { name: "scratch", prefix: false },
    ]);
  });

  test("hidden directories are matched normally", () => {
    expect(
      rankDirectoryMatches(["docs", ".git", ".github"], ".g").map(
        (x) => x.name,
      ),
    ).toEqual([".git", ".github"]);
  });
});

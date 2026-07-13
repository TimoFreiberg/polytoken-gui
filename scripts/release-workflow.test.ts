import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

describe("release workflow", () => {
  test("prepares desktop and headless assets on arm64 with minisign", () => {
    expect(workflow).toContain("runs-on: macos-14 # arm64");
    expect(workflow).toContain("brew install minisign");
    expect(workflow).toContain("pantoken-headless-macos-aarch64.tar.gz");
    expect(workflow).toContain("release-metadata.json");
  });

  test("publishes to the canonical release host", () => {
    expect(workflow).toContain("--repo TimoFreiberg/pantoken");
    expect(workflow).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });

  test("validates before artifact upload", () => {
    const validation = workflow.indexOf("Validate headless artifact");
    const upload = workflow.indexOf("Upload signed release artifacts");
    expect(validation).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(validation);
  });
});

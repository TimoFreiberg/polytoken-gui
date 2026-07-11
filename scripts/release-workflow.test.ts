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

  test("publishes only through the canonical release host token", () => {
    expect(workflow).toContain("--repo TimoFreiberg/polytoken-gui");
    expect(workflow).toContain("GH_TOKEN: ${{ secrets.PANTOKEN_RELEASE_TOKEN }}");
    expect(workflow).not.toContain("github.repository");
    expect(workflow).not.toContain("github.token");
    expect(workflow).toContain("test -n \"$PANTOKEN_RELEASE_TOKEN\"");
  });

  test("validates before artifact upload", () => {
    const validation = workflow.indexOf("Validate headless artifact");
    const upload = workflow.indexOf("Upload signed release artifacts");
    expect(validation).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(validation);
  });
});

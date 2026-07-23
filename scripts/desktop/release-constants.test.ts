import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_ASSET,
  HEADLESS_ASSET,
  HEADLESS_TARGETS,
  RELEASE_REPO,
  TAURI_UPDATER_PUBLIC_KEY,
  assertReleaseTag,
  desktopUpdateEndpoint,
  headlessAssetUrls,
  headlessTargetAssetUrls,
  isReleaseTag,
  latestAssetUrl,
  releaseAssetNames,
  releaseAssetUrl,
} from "./release-constants";

describe("release constants", () => {
  test("uses the canonical release host", () => {
    expect(RELEASE_REPO).toBe("TimoFreiberg/pantoken");
  });

  test("validates strict semantic-version tags", () => {
    expect(isReleaseTag("v1.2.3")).toBe(true);
    expect(isReleaseTag("v01.2.3")).toBe(false);
    expect(isReleaseTag("1.2.3")).toBe(false);
    expect(() => assertReleaseTag("v1.2")).toThrow();
  });

  test("generates canonical desktop and headless URLs", () => {
    expect(desktopUpdateEndpoint()).toBe(
      "https://github.com/TimoFreiberg/pantoken/releases/latest/download/latest.json",
    );
    expect(releaseAssetUrl("v1.2.3", DESKTOP_ASSET)).toContain(
      "/releases/download/v1.2.3/Pantoken.app.tar.gz",
    );
    expect(headlessAssetUrls()).toEqual({
      archive: latestAssetUrl(HEADLESS_ASSET),
      signature: latestAssetUrl(`${HEADLESS_ASSET}.sig`),
    });
    // The full asset list now includes per-target headless artifacts:
    // desktop (2) + latest.json (1) + 2 targets × (asset + sig) (4) = 7.
    expect(releaseAssetNames()).toHaveLength(7);
  });

  test("headless target matrix covers exactly the supported triples", () => {
    expect(HEADLESS_TARGETS).toHaveLength(2);
    const triples = HEADLESS_TARGETS.map((t) => t.targetTriple);
    expect(triples).toEqual([
      "aarch64-apple-darwin",
      "x86_64-unknown-linux-gnu",
    ]);
    // Each target must have a distinct, non-empty asset name.
    const assets = HEADLESS_TARGETS.map((t) => t.asset);
    expect(new Set(assets).size).toBe(assets.length);
    // Linux artifact name must reference its platform.
    const linux = HEADLESS_TARGETS.find(
      (t) => t.targetTriple === "x86_64-unknown-linux-gnu",
    )!;
    expect(linux.asset).toContain("linux");
    expect(linux.signature).toBe(`${linux.asset}.sig`);
  });

  test("per-target headless URLs cover the full matrix", () => {
    const urls = headlessTargetAssetUrls("v1.2.3");
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(u.archive).toContain("/releases/download/v1.2.3/");
      expect(u.signature).toContain("/releases/download/v1.2.3/");
      expect(u.signature).toMatch(/\.sig$/);
    }
  });

  test("matches the checked-in desktop config without changing its key", () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, "../../desktop/tauri.conf.json"), "utf8"),
    ) as { plugins: { updater: { pubkey: string; endpoints: string[] } } };
    expect(config.plugins.updater.pubkey).toBe(TAURI_UPDATER_PUBLIC_KEY);
    expect(config.plugins.updater.endpoints).toEqual([desktopUpdateEndpoint()]);
  });
});

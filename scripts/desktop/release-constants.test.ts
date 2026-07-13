import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_ASSET,
  HEADLESS_ASSET,
  RELEASE_REPO,
  TAURI_UPDATER_PUBLIC_KEY,
  assertReleaseTag,
  desktopUpdateEndpoint,
  headlessAssetUrls,
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
    expect(releaseAssetNames()).toHaveLength(5);
  });

  test("matches the checked-in desktop config without changing its key", () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, "../../desktop/tauri.conf.json"), "utf8"),
    ) as { plugins: { updater: { pubkey: string; endpoints: string[] } } };
    expect(config.plugins.updater.pubkey).toBe(TAURI_UPDATER_PUBLIC_KEY);
    expect(config.plugins.updater.endpoints).toEqual([desktopUpdateEndpoint()]);
  });
});

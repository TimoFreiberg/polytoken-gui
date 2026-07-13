#!/usr/bin/env bun

/** Canonical public release host. */
export const RELEASE_REPO = "TimoFreiberg/pantoken";
export const RELEASE_OWNER = "TimoFreiberg";
export const RELEASE_NAME = "pantoken";
export const RELEASE_BASE_URL = `https://github.com/${RELEASE_REPO}`;

/** Existing Tauri updater key; do not regenerate without an explicit migration. */
export const TAURI_UPDATER_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg2Mjg4ODNBNzJBQzM0MjkKUldRcE5LeHlPb2dvaHJOY2pRbjlDUUtmVE51ZHlrU0h0aUVNRXhLR2JUNER2cktvSVd1Q3NWUFEK";

export const HEADLESS_ASSET = "pantoken-headless-macos-aarch64.tar.gz";
export const HEADLESS_SIGNATURE = `${HEADLESS_ASSET}.sig`;
export const DESKTOP_ASSET = "Pantoken.app.tar.gz";
export const DESKTOP_SIGNATURE = `${DESKTOP_ASSET}.sig`;
export const LATEST_JSON_ASSET = "latest.json";

export function isReleaseTag(value: string): boolean {
  return /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

export function assertReleaseTag(value: string): string {
  if (!isReleaseTag(value)) throw new Error(`invalid release tag '${value}'`);
  return value;
}

export function releaseAssetUrl(tag: string, asset: string): string {
  assertReleaseTag(tag);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset))
    throw new Error(`invalid release asset '${asset}'`);
  return `${RELEASE_BASE_URL}/releases/download/${tag}/${asset}`;
}

export function latestAssetUrl(asset: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset))
    throw new Error(`invalid release asset '${asset}'`);
  return `${RELEASE_BASE_URL}/releases/latest/download/${asset}`;
}

export function desktopUpdateEndpoint(): string {
  return latestAssetUrl(LATEST_JSON_ASSET);
}

export function headlessAssetUrls(tag?: string): {
  archive: string;
  signature: string;
} {
  return tag
    ? {
        archive: releaseAssetUrl(tag, HEADLESS_ASSET),
        signature: releaseAssetUrl(tag, HEADLESS_SIGNATURE),
      }
    : {
        archive: latestAssetUrl(HEADLESS_ASSET),
        signature: latestAssetUrl(HEADLESS_SIGNATURE),
      };
}

export function releaseAssetNames(): string[] {
  return [
    DESKTOP_ASSET,
    DESKTOP_SIGNATURE,
    LATEST_JSON_ASSET,
    HEADLESS_ASSET,
    HEADLESS_SIGNATURE,
  ];
}

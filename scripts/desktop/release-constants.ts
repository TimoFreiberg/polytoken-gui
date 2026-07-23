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

// ── Headless target matrix ──────────────────────────────────────────────────
//
// Each published release must ship a headless artifact for every supported
// target triple (see `pantoken-remote-layout::manifest::SUPPORTED_TARGET_TRIPLES`).
// A target appears here only when its build/smoke/publish pipeline exists.
//
// The asset name encodes the platform so GitHub release downloads are
// self-describing: `pantoken-headless-<os>-<arch>.tar.gz`.

export interface HeadlessTarget {
  /** Rust target triple (matches `SUPPORTED_TARGET_TRIPLES`). */
  readonly targetTriple: string;
  /** Asset archive filename, e.g. `pantoken-headless-macos-aarch64.tar.gz`. */
  readonly asset: string;
  /** Signature filename (asset + `.sig`). */
  readonly signature: string;
  /** `tar.gz` for all current targets. */
  readonly archiveFormat: "tar.gz";
  /** CI runner OS for building this target. */
  readonly runsOn: string;
  /** Platform label embedded in the asset name. */
  readonly platformLabel: string;
}

const MACOS_AARCH64: HeadlessTarget = {
  targetTriple: "aarch64-apple-darwin",
  asset: "pantoken-headless-macos-aarch64.tar.gz",
  signature: "pantoken-headless-macos-aarch64.tar.gz.sig",
  archiveFormat: "tar.gz",
  runsOn: "macos-14",
  platformLabel: "macos-aarch64",
};

const LINUX_X86_64: HeadlessTarget = {
  targetTriple: "x86_64-unknown-linux-gnu",
  asset: "pantoken-headless-linux-x86_64.tar.gz",
  signature: "pantoken-headless-linux-x86_64.tar.gz.sig",
  archiveFormat: "tar.gz",
  runsOn: "ubuntu-latest",
  platformLabel: "linux-x86_64",
};

/**
 * The complete headless target matrix. Adding a target here requires the same
 * change to `SUPPORTED_TARGET_TRIPLES` in the Rust manifest module and a
 * matching CI build/smoke job.
 */
export const HEADLESS_TARGETS: readonly HeadlessTarget[] = [
  MACOS_AARCH64,
  LINUX_X86_64,
];

/** Look up a headless target by its Rust triple. */
export function headlessTargetForTriple(triple: string): HeadlessTarget {
  const target = HEADLESS_TARGETS.find((t) => t.targetTriple === triple);
  if (!target) throw new Error(`unsupported headless target triple: ${triple}`);
  return target;
}

/** The set of asset filenames a release must upload (desktop + all headless). */
export function releaseAssetNames(): string[] {
  const names = [
    DESKTOP_ASSET,
    DESKTOP_SIGNATURE,
    LATEST_JSON_ASSET,
  ];
  for (const t of HEADLESS_TARGETS) {
    names.push(t.asset, t.signature);
  }
  return names;
}

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
  // Legacy convenience: returns the macOS arm64 asset URLs (the original
  // single-target headless artifact). For per-target URLs use
  // `headlessTargetAssetUrls`.
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

/**
 * Per-target headless asset URLs for the full matrix.
 * Returns `{ targetTriple, archive, signature }` for each supported target.
 */
export function headlessTargetAssetUrls(tag?: string): {
  targetTriple: string;
  archive: string;
  signature: string;
}[] {
  return HEADLESS_TARGETS.map((t) => ({
    targetTriple: t.targetTriple,
    archive: tag ? releaseAssetUrl(tag, t.asset) : latestAssetUrl(t.asset),
    signature: tag
      ? releaseAssetUrl(tag, t.signature)
      : latestAssetUrl(t.signature),
  }));
}

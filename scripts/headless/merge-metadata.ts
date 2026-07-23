#!/usr/bin/env bun
// merge-metadata.ts — merge per-target release-metadata.json files into one
// combined file with all headless targets.
//
//   bun scripts/headless/merge-metadata.ts <primary.json> <secondary.json> [<tertiary.json>...]
//
// The primary file (first argument) provides the desktop asset fields and is
// updated in-place. Each subsequent file contributes its `headlessTargets`
// entries. The merged `assetSha256` map is the union of all input maps.
//
// Used by CI to aggregate macOS + Linux build outputs before publish.

import { existsSync } from "node:fs";

interface HeadlessTargetMetadata {
  targetTriple: string;
  asset: string;
  signature: string;
  assetSha256: string;
  signatureSha256: string;
}

interface ReleaseMetadata {
  tag: string;
  version: string;
  buildSha: string;
  releaseRepo: string;
  desktopAsset: string;
  desktopSignature: string;
  latestJsonAsset: string;
  headlessTargets: HeadlessTargetMetadata[];
  assetSha256: Record<string, string>;
}

function fail(msg: string): never {
  console.error(`merge-metadata: ${msg}`);
  process.exit(1);
}

async function readMetadata(path: string): Promise<ReleaseMetadata> {
  if (!existsSync(path)) fail(`metadata file not found: ${path}`);
  return await Bun.file(path).json();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2)
    fail("usage: merge-metadata.ts <primary.json> <secondary.json> [<tertiary.json>...]");

  const primaryPath = args[0]!;
  const secondaryPaths = args.slice(1);

  const primary = await readMetadata(primaryPath);

  // Collect all headless targets, starting from the primary's set.
  const seenTriples = new Set<string>();
  const mergedTargets: HeadlessTargetMetadata[] = [];
  const mergedAssetSha256: Record<string, string> = { ...primary.assetSha256 };

  for (const target of primary.headlessTargets) {
    if (!seenTriples.has(target.targetTriple)) {
      seenTriples.add(target.targetTriple);
      mergedTargets.push(target);
    }
  }

  // Merge each secondary file.
  for (const path of secondaryPaths) {
    const secondary = await readMetadata(path);

    // Sanity: version, tag, buildSha, repo must agree across all inputs.
    if (secondary.tag !== primary.tag || secondary.version !== primary.version)
      fail(`metadata mismatch in ${path}: tag/version disagrees with primary`);
    if (secondary.buildSha !== primary.buildSha)
      fail(`metadata mismatch in ${path}: buildSha disagrees with primary`);
    if (secondary.releaseRepo !== primary.releaseRepo)
      fail(`metadata mismatch in ${path}: releaseRepo disagrees with primary`);

    for (const target of secondary.headlessTargets) {
      if (!seenTriples.has(target.targetTriple)) {
        seenTriples.add(target.targetTriple);
        mergedTargets.push(target);
      }
    }

    Object.assign(mergedAssetSha256, secondary.assetSha256);
  }

  const merged: ReleaseMetadata = {
    ...primary,
    headlessTargets: mergedTargets,
    assetSha256: mergedAssetSha256,
  };

  await Bun.write(primaryPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`merged ${mergedTargets.length} headless targets into ${primaryPath}`);
  for (const t of mergedTargets) {
    console.log(`  ${t.targetTriple}: ${t.asset}`);
  }
}

if (import.meta.main) main();

// Regenerates server/src/polytoken/wire-types.ts from the polytoken binary's own
// self-describing OpenAPI spec (`polytoken openapi`). The OpenAPI spec is the
// single authoritative source: it contains the HTTP request/response schemas AND
// the DaemonEvent union (referenced by SseEnvelope.event), so one pass covers both
// the REST surface and the SSE event stream.
//
// Run: `bun run scripts/codegen-polytoken.ts`
//
// Why a codegen script (not hand-written types)? polytoken is early, and the
// contract WILL drift. Codegen from the binary's own schema means a `bun run
// codegen-polytoken.ts && bunx tsc` after a polytoken bump catches every breaking
// shape change at compile time, instead of at runtime against a live daemon.
//
// The binary path is resolved the same way pilot resolves it at runtime: $PATH, or
// PILOT_POLYTOKEN_BIN. The script fails loud (exit 1) if the binary is missing —
// never silently ships stale types.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const { values } = parseArgs({
  options: {
    bin: { type: "string", default: process.env.PILOT_POLYTOKEN_BIN ?? "polytoken" },
    out: {
      type: "string",
      default: resolve(import.meta.dir, "../server/src/polytoken/wire-types.ts"),
    },
    "no-format": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const bin = values.bin;
  const outPath = values.out;

  // Capture the OpenAPI spec from the binary's own self-description.
  const proc = Bun.spawn({
    cmd: [bin, "openapi"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    console.error(`polytoken openapi failed (exit ${exitCode}): ${err}`);
    console.error(`Is the binary on $PATH or set via PILOT_POLYTOKEN_BIN? (resolved: ${bin})`);
    process.exit(1);
  }
  const openapiJson = await new Response(proc.stdout).text();

  // Sanity: the spec must parse and must contain the DaemonEvent union (the whole
  // point of codegen — if it's missing, the event-fold has nothing to type against).
  let spec: { components?: { schemas?: Record<string, unknown> } };
  try {
    spec = JSON.parse(openapiJson);
  } catch (e) {
    console.error(`polytoken openapi did not emit valid JSON: ${e}`);
    process.exit(1);
  }
  const schemas = spec.components?.schemas;
  if (!schemas || !("DaemonEvent" in schemas) || !("SseEnvelope" in schemas)) {
    console.error(
      "OpenAPI spec is missing DaemonEvent or SseEnvelope schemas — cannot codegen safely.",
    );
    console.error("Present schemas:", Object.keys(schemas ?? {}).length);
    process.exit(1);
  }

  // Write the spec to a temp file (openapi-typescript's stdin support is fragile
  // across Node/Bun runtimes — a temp file is robust and the cleanup is trivial).
  const tmpDir = mkdtempSync(resolve(tmpdir(), "polytoken-codegen-"));
  const specPath = resolve(tmpDir, "openapi.json");
  writeFileSync(specPath, openapiJson);

  const codegen = Bun.spawn({
    cmd: ["bunx", "openapi-typescript", specPath, "-o", outPath],
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir,
  });

  const cgExit = await codegen.exited;
  const cgStderr = await new Response(codegen.stderr).text();
  rmSync(tmpDir, { recursive: true, force: true });
  if (cgExit !== 0) {
    console.error(`openapi-typescript failed (exit ${cgExit}): ${cgStderr}`);
    process.exit(1);
  }

  if (!values["no-format"]) {
    try {
      await $`bunx biome format --write ${outPath}`.quiet();
    } catch {
      // Biome is a dev convenience, not a gate — the types compile regardless.
    }
  }

  // Report what landed.
  const generated = readFileSync(outPath, "utf8");
  const variantCount = (generated.match(/type: "/g) ?? []).length;
  console.log(
    `✓ generated ${outPath.replace(import.meta.dir + "/", "")} ` +
      `(${generated.split("\n").length} lines, ${variantCount} tagged variants across HTTP + SSE)`,
  );
  console.log("  regenerate after a polytoken bump: bun run scripts/codegen-polytoken.ts");
}

await main();

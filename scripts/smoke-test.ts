#!/usr/bin/env bun
// smoke-test.ts — boot a freshly-built pilot server in isolation and confirm it
// actually serves before a deploy flips it live. Run against a *staged* slot by
// auto-deploy.sh (step 4); also runnable by hand: `bun scripts/smoke-test.ts [dir]`.
//
// It boots with the MOCK driver on a scratch port and a throwaway data dir, so it
// never touches real daemon state, the live instance's port, or the prod push
// subscriptions. Exit 0 = safe to flip; non-zero = abort, live slot untouched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const stageDir = process.argv[2] ?? resolve(import.meta.dir, "..");
const port = Number(process.env.PILOT_SMOKE_PORT ?? 8799);
const base = `http://127.0.0.1:${port}`;

const serverDir = join(stageDir, "server-rs");
const clientDist = join(stageDir, "client", "dist");
const dataDir = mkdtempSync(join(tmpdir(), "pilot-smoke-"));

function fail(msg: string): never {
  console.error(`smoke-test: FAIL — ${msg}`);
  cleanup();
  process.exit(1);
}

let proc: ReturnType<typeof Bun.spawn> | null = null;
function cleanup(): void {
  try {
    proc?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.error(
  `smoke-test: booting staged server from ${serverDir} on :${port}`,
);
proc = Bun.spawn(["cargo", "run"], {
  cwd: serverDir,
  env: {
    ...process.env,
    PILOT_DRIVER: "mock",
    PILOT_HOST: "127.0.0.1",
    PILOT_PORT: String(port),
    PILOT_DATA_DIR: dataDir,
    PILOT_CLIENT_DIST: clientDist,
    PILOT_TOKEN: "", // tokenless: /health and / are open, simplest to probe
  },
  stdout: "inherit",
  stderr: "inherit",
});

// If the process dies during boot, surface it instead of hanging on the poll.
let exited = false;
void proc.exited.then((code) => {
  exited = true;
  if (code !== 0) fail(`server exited early with code ${code}`);
});

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) fail("server exited before answering /health");
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(150);
  }
  fail(`/health did not return {ok:true} within ${timeoutMs}ms`);
}

await waitForHealth();
console.error("smoke-test: /health ok");

// Confirm the built client is actually being served — not the "no client build"
// placeholder the server returns when client/dist is missing.
const rootRes = await fetch(`${base}/`);
const html = await rootRes.text();
if (!rootRes.ok) fail(`GET / returned ${rootRes.status}`);
if (html.includes("no client build"))
  fail("client/dist missing — build did not run");
if (!/<!doctype html/i.test(html)) {
  fail(`GET / did not serve an HTML document (got: ${html.slice(0, 80)}…)`);
}
console.error("smoke-test: built client served");

console.error("smoke-test: all checks passed");
cleanup();
process.exit(0);

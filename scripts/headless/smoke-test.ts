#!/usr/bin/env bun
// smoke-test.ts — smoke test a staged headless release artifact.
//
//   bun scripts/headless/smoke-test.ts <extracted-dir> [--port <port>]
//
// Steps:
//   1. Run bin/pantoken-server with PANTOKEN_DRIVER=mock, bound to a non-8787 port
//   2. Assert /health returns { ok: true }
//   3. Assert / serves real HTML (not an error page)
//   4. Connect via WebSocket and verify the hello message contains build_sha
//   5. Compare build_sha with the payload BUILD_SHA file
//   6. Clean up the process
//
// Exit 0 on success, 1 on failure.

import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../..");

function fail(msg: string): never {
  console.error(`smoke-test: ${msg}`);
  process.exit(1);
}

// ── argument parsing ──

function parseArgs(argv: string[]): { extractedDir: string; port: number } {
  const args = argv;
  let extractedDir: string | undefined;
  let port = 0; // 0 = auto-assign from env or fallback

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      port = parseInt(args[i + 1]!, 10);
      if (isNaN(port) || port < 1024 || port > 65535)
        fail(`invalid port: ${args[i + 1]}`);
      i++;
    } else if (!args[i]!.startsWith("--")) {
      extractedDir = args[i]!;
    }
  }

  if (!extractedDir)
    fail(`usage: smoke-test.ts <extracted-dir> [--port <port>]`);

  // Honor PANTOKEN_SMOKE_PORT env var for test harness override
  const envPort = process.env.PANTOKEN_SMOKE_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (!isNaN(p) && p >= 1024 && p <= 65535) port = p;
  }

  // Default port for smoke test (non-production, avoid 8787)
  if (port === 0) port = 9787;

  return { extractedDir: resolve(extractedDir), port };
}

// ── HTTP helper ──

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const text = await resp.text();
  return { status: resp.status, text };
}

// ── WebSocket helper ──

async function connectWS(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("WS open timeout")), 5000);
    ws.onerror = () => reject(new Error("WS connection failed"));
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
  });
}

// ── main ──

async function main(): Promise<void> {
  const { extractedDir, port } = parseArgs(process.argv.slice(2));

  // Validate the staging directory has required files
  const binaryPath = join(extractedDir, "bin", "pantoken-server");
  const envFile = join(extractedDir, "run.sh");
  const buildShaPath = join(extractedDir, "BUILD_SHA");

  if (!existsSync(binaryPath))
    fail(`staged binary not found: ${binaryPath}`);

  if (!existsSync(envFile))
    fail(`run.sh not found: ${envFile}`);

  if (!existsSync(buildShaPath))
    fail(`BUILD_SHA not found: ${buildShaPath}`);

  const expectedBuildSha = readFileSync(buildShaPath, "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(expectedBuildSha))
    fail(`BUILD_SHA has invalid format: ${expectedBuildSha}`);

  console.log(`Staged binary: ${binaryPath}`);
  console.log(`Expected build_sha: ${expectedBuildSha.slice(0, 12)}...${expectedBuildSha.slice(-4)}`);

  // ── launch the server ──
  const dataDir = mkdtempSync(join(tmpdir(), "pantoken-smoke-"));
  let serverProc: ReturnType<typeof spawn> | null = null;

  try {
    console.log(`Launching server on port ${port} (data dir: ${dataDir})...`);

    serverProc = spawn(binaryPath, [], {
      env: {
        ...process.env,
        PANTOKEN_DRIVER: "mock",
        PANTOKEN_PORT: String(port),
        PANTOKEN_DATA_DIR: dataDir,
        PANTOKEN_HOST: "127.0.0.1",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the server to be ready
    let ready = false;
    let retries = 30;
    while (!ready && retries > 0) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const health = await fetchText(`http://127.0.0.1:${port}/health`);
        if (health.status === 200) {
          const body = JSON.parse(health.text);
          if (body.ok) {
            ready = true;
            console.log(`Server ready: /health returned { ok: true }`);
          }
        }
      } catch {
        // Server not ready yet
      }
      retries--;
    }

    if (!ready) {
      // Capture stderr for debugging
      const stderrChunks: Buffer[] = [];
      serverProc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 500);
      fail(`Server did not become healthy within 9 seconds. stderr: ${stderr || "(none)"}`);
    }

    // ── Check / serves HTML ──
    console.log("Checking / serves HTML...");
    const rootResp = await fetchText(`http://127.0.0.1:${port}/`);
    if (rootResp.status !== 200)
      fail(`/ returned status ${rootResp.status}: ${rootResp.text.slice(0, 200)}`);
    if (!rootResp.text.includes("<!doctype") && !rootResp.text.includes("<html"))
      fail(`/ did not serve HTML (first 100 chars: ${rootResp.text.slice(0, 100)})`);
    console.log(`  / served ${rootResp.text.length} bytes of HTML`);

    // ── WebSocket hello with build_sha ──
    console.log("Connecting via WebSocket to check hello message...");
    const ws = await connectWS(`ws://127.0.0.1:${port}/ws`);

    const helloPromise = new Promise<any>((resolve) => {
      let resolved = false;
      ws.onmessage = (event: any) => {
        if (resolved) return;
        resolved = true;
        try {
          const msg = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          resolve(msg);
        } catch {
          resolve({ raw: String(event.data).slice(0, 200) });
        }
      };
      // Timeout after 3s
      setTimeout(() => {
        if (!resolved) resolve({ timeout: true });
      }, 3000);
    });

    ws.onerror = () => {
      // Connection may have been lost before receiving hello
    };

    const hello = await helloPromise;
    ws.close();

    if (hello.timeout)
      fail("WebSocket did not receive a hello message within 3 seconds");

    if (!hello.build_sha)
      fail("WebSocket hello missing 'build_sha' field");

    if (typeof hello.build_sha !== "string")
      fail(`WebSocket hello build_sha is not a string: ${typeof hello.build_sha}`);

    if (!/^[0-9a-f]{40}$/.test(hello.build_sha))
      fail(`WebSocket hello build_sha has invalid format: ${hello.build_sha}`);

    if (hello.build_sha !== expectedBuildSha)
      fail(
        `build_sha mismatch: WS hello has ${hello.build_sha}, ` +
        `expected ${expectedBuildSha} from BUILD_SHA file`,
      );

    console.log(`  WS hello build_sha: ${hello.build_sha.slice(0, 12)}...${hello.build_sha.slice(-4)}`);
    console.log("  build_sha matches BUILD_SHA file ✓");

    // ── success ──
    console.log("\nSmoke test: PASS");
    console.log(`  Server binary: ${binaryPath}`);
    console.log(`  Port: ${port}`);
    console.log(`  Data dir: ${dataDir}`);
    console.log(`  build_sha: ${expectedBuildSha}`);

  } finally {
    // ── cleanup ──
    if (serverProc) {
      serverProc.kill("SIGTERM");
      try {
        await new Promise<void>((resolve) => {
          serverProc!.on("exit", () => resolve());
          setTimeout(resolve, 3000);
        });
      } catch {
        // Already exited
      }
      // Force kill if still alive
      try { serverProc.kill("SIGKILL"); } catch { /* ignore */ }
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(0);
}

if (import.meta.main) main();

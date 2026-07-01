// Resolve which login shell to use, capture its env at startup, and report the live
// status of that capture for the Settings panel (configured vs active).
//
// When pilot is launched from the desktop `.app` bundle it inherits launchd's minimal
// PATH (`/usr/bin:/bin`) — no brew/nvm — so the polytoken daemon spawned by pilot gets a
// broken PATH and its `shell_exec` tool can't find user tools. `captureLoginEnv` runs
// at polytoken-driver construction: it spawns `<shell> -l -c 'env'` (login shell only,
// NOT interactive — avoids sourcing .zshrc where p10k/direnv/pyenv/nvm live and can
// hang), parses the output, and the caller passes the result as `env` to every daemon
// spawn. `getLoginEnvStatus` reports the capture outcome so the Settings panel can show
// what's active and prompt for a restart when the configured shell differs.

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import type { LoginEnvStatus } from "@pilot/protocol";

let status: LoginEnvStatus = {
  activeShell: null,
  ok: false,
  detail: "not captured",
};

/** Live status of the startup capture, for the Settings panel (configured vs active). */
export function getLoginEnvStatus(): LoginEnvStatus {
  return status;
}

/** Resolve which shell to run: the configured override wins, then `$SHELL`, then the
 *  OS passwd login shell, then sane fallbacks. Returns null if none exists on disk. */
export function resolveLoginShell(configured: string | null): string | null {
  const candidates = [
    configured,
    process.env.SHELL ?? null,
    userInfo().shell, // POSIX login shell from the passwd db; null on some platforms
    "/bin/zsh",
    "/bin/bash",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** Parse `env`-format output into a record, skipping lines that don't match
 *  `^[A-Za-z_][A-Za-z0-9_]*=`. This filters motd/fortune/other stdout noise that
 *  login rc files may print. Values are split on the FIRST `=` only (so `FOO=a=b`
 *  → `{ FOO: "a=b" }`). Exported for unit testing. */
export function parseEnvOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key) out[key] = value;
  }
  return out;
}

/** Capture the login-shell environment by spawning `<shell> -l -c 'env'`.
 *  Login shell only (NOT `-i` interactive): sources `.zprofile`/`.zshenv` (where PATH
 *  is typically set) WITHOUT sourcing `.zshrc` (where p10k/direnv/pyenv/nvm live —
 *  any of which can take >5s on a cold start or hang on a network home dir).
 *
 *  Never throws — all failure paths return `{ env: {} }` + a status struct with
 *  `ok: false`. A capture failure degrades to current behavior (empty merge = broken
 *  PATH, unchanged from today). Does NOT mutate module-level `status`; returns the
 *  struct so the caller assigns it (keeps tests order-independent). */
export async function captureLoginEnv(
  configured: string | null,
): Promise<{ env: Record<string, string>; status: LoginEnvStatus }> {
  const shell = resolveLoginShell(configured);
  if (!shell) {
    return {
      env: {},
      status: { activeShell: null, ok: false, detail: "no login shell found" },
    };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [shell, "-l", "-c", "env"],
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    return {
      env: {},
      status: {
        activeShell: shell,
        ok: false,
        detail: `capture failed: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Already dead — best-effort.
    }
  }, 5_000);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return {
        env: {},
        status: { activeShell: shell, ok: false, detail: "capture timed out" },
      };
    }
    if (exitCode !== 0) {
      return {
        env: {},
        status: {
          activeShell: shell,
          ok: false,
          detail: `capture failed: ${stderr.slice(0, 200)}`,
        },
      };
    }
    const parsed = parseEnvOutput(stdout);
    return {
      env: parsed,
      status: {
        activeShell: shell,
        ok: true,
        detail: `${Object.keys(parsed).length} vars captured`,
      },
    };
  } catch (e) {
    return {
      env: {},
      status: {
        activeShell: shell,
        ok: false,
        detail: `capture failed: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Set the module-level status — the single mutation point, called once from
 *  `createPolytokenDriver`. `captureLoginEnv` returns the struct; this assigns it. */
export function setLoginEnvStatus(s: LoginEnvStatus): void {
  status = s;
}

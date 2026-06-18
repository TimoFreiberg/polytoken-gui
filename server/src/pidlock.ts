// PID lock + stable server identity. Nothing structurally stops two pilot
// processes from sharing one config.dataDir, and if they do they fight over the
// archive/worktree/push stores and — the real hazard — the VAPID keypair, whose
// regeneration silently invalidates every phone's push subscription. So on
// startup we take an exclusive lock at `dataDir/pilot.pid`.
//
// House failure philosophy: a double-start should fail LOUD and diagnosable, not
// clobber. A lock held by a LIVE process aborts startup with the offending pid +
// data dir named; a STALE lock (its pid is gone) is reclaimed silently — that's a
// crash/kill leftover, not a conflict.
//
// We also mint a stable `server-id` (random hex, once per data dir) for identity
// and logging, reused across restarts.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Parsed contents of a pilot.pid lock file. */
export interface LockInfo {
  pid: number;
  /** server-id of the holder, if it was recorded (older locks may omit it). */
  serverId?: string;
}

/**
 * Parse a lock file's text into a LockInfo, or null if it's unusable (empty,
 * garbage, or a non-positive pid). A null parse is treated as "no valid lock" by
 * the caller — i.e. reclaimable — because an unparseable lock can't name a live
 * process to defer to.
 *
 * The on-disk format is a single JSON object; we also accept a bare integer for
 * forward/backward tolerance.
 */
export function parseLock(text: string): LockInfo | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let pid: number;
  let serverId: string | undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "number") {
      pid = parsed;
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as { pid?: unknown; serverId?: unknown };
      pid = typeof obj.pid === "number" ? obj.pid : Number.NaN;
      if (typeof obj.serverId === "string") serverId = obj.serverId;
    } else {
      return null;
    }
  } catch {
    // Tolerate a bare integer that isn't valid JSON-as-written (it usually is,
    // but a hand-edited file might be e.g. "12345\n").
    pid = Number(trimmed);
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return serverId === undefined ? { pid } : { pid, serverId };
}

/**
 * Is `pid` a live process we should defer to? Uses signal 0, which performs the
 * permission/existence checks without delivering a signal:
 *   - throws ESRCH  -> no such process            -> dead
 *   - throws EPERM  -> exists but not ours to signal -> ALIVE (treat as live;
 *     a different user owns it, so it's certainly running)
 *   - no throw      -> alive
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    // ESRCH (or anything else we can't interpret) -> treat as not-alive so a
    // genuinely stale lock can be reclaimed.
    return false;
  }
}

/**
 * Decide what to do with an existing lock given the current pid.
 *   - no/empty/garbage lock      -> "reclaim"
 *   - lock pid is us             -> "reclaim" (re-entrant; e.g. --hot reload)
 *   - lock pid is a live process -> "live"   (caller must abort)
 *   - lock pid is dead           -> "reclaim"
 */
export function lockDecision(
  existing: LockInfo | null,
  selfPid: number,
): "reclaim" | "live" {
  if (!existing) return "reclaim";
  if (existing.pid === selfPid) return "reclaim";
  return isPidAlive(existing.pid) ? "live" : "reclaim";
}

/** Error thrown when a live lock blocks startup. Carries the data for a clear log. */
export class LockHeldError extends Error {
  constructor(
    readonly pid: number,
    readonly dataDir: string,
    readonly lockPath: string,
  ) {
    super(
      `pilot is already running: pid ${pid} holds the lock at ${lockPath} ` +
        `(data dir ${dataDir}). Refusing to start a second server on the same ` +
        `data dir — two servers would corrupt the archive/worktree/push stores ` +
        `and regenerating the VAPID keypair would invalidate every phone's push ` +
        `subscription. Stop that process, or point this one at a different ` +
        `PILOT_DATA_DIR.`,
    );
    this.name = "LockHeldError";
  }
}

export interface PidLock {
  readonly path: string;
  readonly pid: number;
  readonly serverId: string;
  /** Remove our lock file (idempotent). Safe to call from shutdown handlers. */
  release(): void;
}

/**
 * Acquire the PID lock at `dataDir/pilot.pid`, reclaiming a stale one and throwing
 * LockHeldError if a live process holds it. Writes our pid + serverId. The caller
 * is responsible for wiring `release()` to shutdown.
 *
 * Pure-logic helpers (parseLock / isPidAlive / lockDecision) are exported so the
 * decision can be unit-tested without spawning processes.
 */
export function acquirePidLock(
  dataDir: string,
  serverId: string,
  selfPid: number = process.pid,
): PidLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, "pilot.pid");

  const existing = existsSync(lockPath)
    ? parseLock(readFileSync(lockPath, "utf8"))
    : null;

  if (lockDecision(existing, selfPid) === "live") {
    // existing is non-null here (lockDecision only returns "live" for a live pid).
    throw new LockHeldError(existing!.pid, dataDir, lockPath);
  }

  writeFileSync(lockPath, JSON.stringify({ pid: selfPid, serverId }), "utf8");

  return {
    path: lockPath,
    pid: selfPid,
    serverId,
    release() {
      try {
        // Only unlink if it's still ours — never delete a lock another process
        // took over after we wrote ours (shouldn't happen, but cheap to guard).
        if (!existsSync(lockPath)) return;
        const cur = parseLock(readFileSync(lockPath, "utf8"));
        if (cur && cur.pid !== selfPid) return;
        unlinkSync(lockPath);
      } catch {
        // Best-effort on shutdown; a leftover lock is reclaimed as stale next start.
      }
    },
  };
}

/**
 * Mint-or-read the stable server-id for a data dir. Created once (random 16-byte
 * hex) and persisted at `dataDir/server-id`; every later read returns the same
 * value. Trims whitespace and treats an empty/whitespace file as absent (so a
 * truncated write self-heals on the next read).
 */
export function mintOrReadServerId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const idPath = join(dataDir, "server-id");
  if (existsSync(idPath)) {
    const existing = readFileSync(idPath, "utf8").trim();
    if (existing) return existing;
  }
  const id = randomBytes(16).toString("hex");
  mkdirSync(dirname(idPath), { recursive: true });
  writeFileSync(idPath, id, "utf8");
  return id;
}

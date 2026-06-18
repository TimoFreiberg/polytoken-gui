// Tiny dependency-free structured logger. Writes JSON-lines to `dataDir/pilot.log`
// (one `{ts, level, msg, ...fields}` object per line) AND mirrors a human-readable
// line to the console, so `bun run dev` stays readable while a durable log
// accumulates for after-the-fact debugging.
//
// Size-based rotation with node:fs only (no pino, no logrotate): when the active
// file crosses ~5MB we roll pilot.log -> pilot.log.1 -> pilot.log.2 ... up to a
// cap, pruning the oldest. Rotation is checked before each append; a single
// oversized line still gets written (we roll, then write it fresh).
//
// The server-id (see pidlock.ts) is attached to every line once it's known, so
// log lines are attributable to a specific server instance / data dir.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  /** Absolute path to the active log file (e.g. `dataDir/pilot.log`). */
  file: string;
  /** Roll once the active file is at/over this many bytes. Default ~5MB. */
  maxBytes?: number;
  /** How many rolled generations to keep (pilot.log.1 .. .N). Default 3. */
  maxGenerations?: number;
  /** Stable server id, stamped onto every line when set. */
  serverId?: string;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_GENERATIONS = 3;

type Fields = Record<string, unknown>;

/**
 * Rotate `file` if it is at/over `maxBytes`. Shifts generations down
 * (file.N-1 -> file.N, dropping the old file.N), then file -> file.1. Keeps at
 * most `maxGenerations` rolled files. Returns true if a roll happened.
 *
 * Pure-ish (touches the filesystem only); exported for unit testing the policy
 * without going through the Logger.
 */
export function rotateIfNeeded(
  file: string,
  maxBytes: number,
  maxGenerations: number,
): boolean {
  if (!existsSync(file)) return false;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  // Drop the oldest generation if it's at the cap, then shift each down by one.
  // With maxGenerations=3 we keep .1 .2 .3; the would-be .4 is pruned.
  const oldest = `${file}.${maxGenerations}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      // ignore — best effort
    }
  }
  for (let i = maxGenerations - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        // ignore — best effort
      }
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    return false;
  }
  return true;
}

export class Logger {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxGenerations: number;
  private serverId: string | undefined;

  constructor(opts: LoggerOptions) {
    this.file = opts.file;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxGenerations = opts.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    this.serverId = opts.serverId;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  /** Stamp every subsequent line with this server-id (set once it's known). */
  setServerId(id: string): void {
    this.serverId = id;
  }

  debug(msg: string, fields?: Fields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.write("error", msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Fields): void {
    const ts = new Date().toISOString();
    const record: Fields = { ts, level, msg };
    if (this.serverId) record.serverId = this.serverId;
    if (fields) Object.assign(record, fields);

    // Console mirror first — it must never be blocked by a disk problem.
    this.mirrorToConsole(level, ts, msg, fields);

    try {
      rotateIfNeeded(this.file, this.maxBytes, this.maxGenerations);
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
    } catch (e) {
      // Don't let a logging failure take down the server. Surface it on the
      // console (which still works) so it isn't silent.
      console.error("[log] failed to write log file", this.file, e);
    }
  }

  private mirrorToConsole(
    level: LogLevel,
    ts: string,
    msg: string,
    fields?: Fields,
  ): void {
    const id = this.serverId ? ` ${this.serverId.slice(0, 8)}` : "";
    const extra =
      fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    const line = `[pilot${id}] ${ts} ${level} ${msg}${extra}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

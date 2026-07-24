// Pure formatting helpers for Docker container targets.
//
// No Svelte, no DOM — these are pure functions used by the setup dialog,
// switcher, and Settings to format container names, backing, risk
// invalidation keys, pantoken-root suggestions, and failure copy.

import type {
  ContainerInspection,
  FailureFamily,
  MountSummary,
  RiskAcknowledgements,
} from "./types.js";
import { redactSshDestination } from "./types.js";

// ── Name humanization ───────────────────────────────────────────────────────

/** Common technical acronyms that should be fully uppercased when they appear
 *  as a word in a container name (e.g. `work-api-dev` → `Work API Dev`). */
const ACRONYMS = new Set([
  "api",
  "url",
  "id",
  "ssh",
  "cli",
  "sdk",
  "ui",
  "ux",
  "ai",
  "ml",
  "db",
  "sql",
  "dns",
  "http",
  "https",
  "tcp",
  "udp",
  "ip",
  "vm",
  "os",
  "ci",
  "cd",
]);

/**
 * Humanize a container or profile name: `work-api-dev` → `Work API Dev`.
 * Splits on `-`, `_`, `.`, capitalizes each word, joins with spaces. Known
 * technical acronyms (api, ssh, db, etc.) are fully uppercased.
 *
 * Never overwrites a user-edited name — callers must check `nameTouched`
 * before applying.
 */
export function humanizeContainerName(name: string): string {
  return name
    .split(/[-_.]/)
    .filter((w) => w.length > 0)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * For host targets, suggest a label from the SSH destination after a
 * successful test. Uses `redactSshDestination` to strip the user and port,
 * returning the bare host or alias.
 */
export function humanizeSshHost(destination: string): string {
  const { host } = redactSshDestination(destination);
  return host;
}

// ── Pantoken root suggestion ────────────────────────────────────────────────

/**
 * Returns `resolvedHome + "/.local/share/pantoken"`. Never returns `~`.
 * Callers recompute when the container user changes unless the user edited
 * the path manually.
 */
export function suggestPantokenRoot(resolvedHome: string): string {
  const trimmed = resolvedHome.replace(/\/+$/, "");
  return `${trimmed}/.local/share/pantoken`;
}

// ── Backing formatting ───────────────────────────────────────────────────────

/**
 * Format the persistence backing line for a container inspection.
 * Returns `Persistent · volume <name>`, `Persistent · bind mount <path>`,
 * or `Ephemeral · container writable layer` based on the mount covering the
 * pantoken root path.
 *
 * The backing is determined by the mount that covers the pantoken root:
 * - A named volume mount → `Persistent · volume <name>`
 * - A bind mount → `Persistent · bind mount <path>`
 * - No covering mount (writable layer) → `Ephemeral · container writable layer`
 * - A tmpfs mount → `Ephemeral · tmpfs <destination>` (rare)
 */
export function formatBacking(inspection: ContainerInspection): string {
  const rootPath = inspection.pantokenRootSuggestion;

  // Find the mount that covers the pantoken root path (longest prefix match).
  const covering = findCoveringMount(inspection.mounts, rootPath);

  if (!covering) {
    return "Ephemeral · container writable layer";
  }

  switch (covering.type) {
    case "volume":
      return `Persistent · volume ${covering.name ?? covering.destination}`;
    case "bind":
      return `Persistent · bind mount ${covering.source ?? covering.destination}`;
    case "tmpfs":
      return `Ephemeral · tmpfs ${covering.destination}`;
    case "writableLayer":
      return "Ephemeral · container writable layer";
    default:
      return "Ephemeral · container writable layer";
  }
}

/**
 * Find the mount whose destination is the longest prefix of `path`.
 * Returns undefined if no mount covers the path (meaning it's on the
 * container's writable layer).
 */
function findCoveringMount(
  mounts: MountSummary[],
  path: string,
): MountSummary | undefined {
  let best: MountSummary | undefined;
  let bestLen = -1;
  for (const m of mounts) {
    if (m.type === "writableLayer") continue;
    const dest = m.destination.replace(/\/+$/, "");
    if (path.startsWith(dest + "/") || path === dest) {
      if (dest.length > bestLen) {
        best = m;
        bestLen = dest.length;
      }
    }
  }
  return best;
}

// ── Risk invalidation keys ───────────────────────────────────────────────────
//
// These pure functions compute the invalidation key for each risk kind, so
// callers can compare the stored fingerprint against the current resolved
// environment. A risk is invalidated (must re-prompt) when the key changes.
//
// - Root ack: invalidated by new container ID.
// - Ephemeral waiver: invalidated by root path or mount backing change.
// - Socket ack: invalidated by container replacement / socket mount change.
//
// Socket acks are persisted client-side in localStorage (not in
// RiskAcknowledgements — the Rust struct has no socket field). These
// functions provide the keys for comparison.

export interface RiskFingerprintEnv {
  /** Immutable container ID for the current connection attempt. */
  containerId: string;
  /** The absolute pantoken root path. */
  pantokenRoot: string;
  /** The backing classification (from formatBacking). */
  backingKey: string;
  /** Whether a Docker socket mount is present. */
  hasSocketMount: boolean;
  /** The socket mount fingerprint (source path or mount identity). */
  socketMountKey?: string;
}

/**
 * Compute the invalidation key for the root-execution risk.
 * Invalidated by a new container ID.
 */
export function rootRiskKey(env: RiskFingerprintEnv): string {
  return `root:${env.containerId}`;
}

/**
 * Compute the invalidation key for the ephemeral-data risk.
 * Invalidated by root path or mount backing change.
 */
export function ephemeralRiskKey(env: RiskFingerprintEnv): string {
  return `ephemeral:${env.pantokenRoot}:${env.backingKey}`;
}

/**
 * Compute the invalidation key for the Docker-socket risk.
 * Invalidated by container replacement or socket mount change.
 */
export function socketRiskKey(env: RiskFingerprintEnv): string {
  if (!env.hasSocketMount) return "socket:none";
  return `socket:${env.containerId}:${env.socketMountKey ?? "unknown"}`;
}

/**
 * Check whether a given risk acknowledgement is still valid against the
 * current resolved environment.
 */
export function isRiskAckValid(
  kind: "rootExecution" | "ephemeralData" | "dockerSocket",
  storedFingerprint: string | undefined,
  env: RiskFingerprintEnv,
): boolean {
  if (!storedFingerprint) return false;
  switch (kind) {
    case "rootExecution":
      return storedFingerprint === rootRiskKey(env);
    case "ephemeralData":
      return storedFingerprint === ephemeralRiskKey(env);
    case "dockerSocket":
      return storedFingerprint === socketRiskKey(env);
  }
}

/**
 * Compute all risk keys for an environment, for comparison against stored
 * acknowledgements. Returns the keys that the UI uses to decide whether to
 * re-prompt.
 */
export function computeRiskKeys(env: RiskFingerprintEnv): {
  root: string;
  ephemeral: string;
  socket: string;
} {
  return {
    root: rootRiskKey(env),
    ephemeral: ephemeralRiskKey(env),
    socket: socketRiskKey(env),
  };
}

/**
 * Determine which risks need re-acknowledgement by comparing stored acks
 * against the current environment keys.
 */
export function risksNeedingAcknowledgement(
  acks: RiskAcknowledgements,
  socketAckKey: string | undefined,
  env: RiskFingerprintEnv,
): ("rootExecution" | "ephemeralData" | "dockerSocket")[] {
  const needed: ("rootExecution" | "ephemeralData" | "dockerSocket")[] = [];
  if (!isRiskAckValid("rootExecution", env.containerId ? acks.rootFingerprint : undefined, env)) {
    needed.push("rootExecution");
  }
  if (!isRiskAckValid("ephemeralData", acks.ephemeralFingerprint, env)) {
    needed.push("ephemeralData");
  }
  if (
    env.hasSocketMount &&
    !isRiskAckValid("dockerSocket", socketAckKey, env)
  ) {
    needed.push("dockerSocket");
  }
  return needed;
}

// ── Socket mount detection ───────────────────────────────────────────────────

/**
 * Detect whether any mount is a Docker socket mount (bind mount with a source
 * path ending in `docker.sock`). Returns the mount if found.
 */
export function findSocketMount(
  mounts: MountSummary[],
): MountSummary | undefined {
  return mounts.find(
    (m) =>
      m.type === "bind" &&
      ((m.source && m.source.endsWith("docker.sock")) ||
        m.destination.endsWith("docker.sock")),
  );
}

// ── Failure family formatting ─────────────────────────────────────────────────

export interface FailureFamilyInfo {
  /** User-facing label (failureLabel). */
  label: string;
  /** Primary action label (failureAction). */
  action: string;
  /** Whether technical details should be shown behind a disclosure. */
  detailBehavior: "redacted" | "none";
}

/**
 * Map a failure family to user-facing copy + next action + detail behavior.
 * Each family has plain-language user copy, one concrete next action, and
 * redacted details behind a `Show technical details` disclosure.
 */
export function formatFailureFamily(family: FailureFamily): FailureFamilyInfo {
  switch (family) {
    case "dockerUnavailable":
      return {
        label:
          "Docker CLI is not available on the SSH host, or the SSH account doesn't have permission to use it.",
        action: "Install Docker on the host, or fix the SSH account's Docker group membership.",
        detailBehavior: "redacted",
      };
    case "containerNotFound":
      return {
        label: "No running container matches the exact name.",
        action: "Check the container name spelling, or start the container outside Pantoken.",
        detailBehavior: "redacted",
      };
    case "containerStopped":
      return {
        label: "Container exists but is not running.",
        action: "Start the container outside Pantoken, then click Retry.",
        detailBehavior: "redacted",
      };
    case "ambiguousMatch":
      return {
        label: "Multiple containers have the exact name. Use a unique container name.",
        action: "Rename the container outside Pantoken to make it unique.",
        detailBehavior: "redacted",
      };
    case "userMissing":
      return {
        label: "The configured container user does not exist in the container.",
        action: "Edit the container user in the profile to match a user that exists in the container.",
        detailBehavior: "redacted",
      };
    case "acknowledgementRequired":
      return {
        label: "Risk acknowledgement required.",
        action: "Accept risks & continue",
        detailBehavior: "none",
      };
    case "rootNotWritable":
      return {
        label: "The Pantoken root is not writable by the selected user.",
        action: "Fix directory permissions in the container, or choose a different Pantoken root.",
        detailBehavior: "redacted",
      };
    case "rootNotMounted":
      return {
        label:
          "The Pantoken root is on the container's writable layer (no persistent mount).",
        action: "Choose another path",
        detailBehavior: "redacted",
      };
    case "replacementMismatch":
      return {
        label:
          "The container was replaced with a new container that has incompatible architecture/environment.",
        action: "Choose another container",
        detailBehavior: "redacted",
      };
    case "containerSupportUnavailable":
      return {
        label: "Container support unavailable on this device",
        action: "",
        detailBehavior: "none",
      };
    case "containerNotRunning":
      return {
        label: "Container not running",
        action: "Retry",
        detailBehavior: "none",
      };
  }
}

// ── Risk body copy ────────────────────────────────────────────────────────────

export interface RiskBody {
  title: string;
  body: string;
  /** Primary action label when this is the only risk. */
  alternatePrimary?: string;
}

/** The exact risk card copy from the task brief (item 12). */
export const RISK_BODIES: Record<
  "rootExecution" | "ephemeralData" | "dockerSocket",
  RiskBody
> = {
  rootExecution: {
    title: "Agent runs as root",
    body:
      "Agent commands will run as root. Files in bind-mounted workspaces may become root-owned. Mounted host paths or a Docker socket can expose broader host access; container root is not necessarily isolated from the host.",
  },
  ephemeralData: {
    title: "Ephemeral Pantoken root",
    body:
      "Pantoken data will be lost when this container is replaced. Sessions, runtime files, and Pantoken-managed agent data stored here exist only in this container's writable layer.",
    alternatePrimary: "Choose another path",
  },
  dockerSocket: {
    title: "Docker socket exposed",
    body:
      "This container can control Docker on the host. The mounted Docker socket may let agent commands create privileged containers, mount host paths, or otherwise gain host-level access.",
  },
};

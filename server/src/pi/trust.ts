// Project-trust gate for the real pi driver (D12). pi only resolves project trust
// when the host hands the ResourceLoader a `resolveProjectTrust` callback; pass none
// and `SettingsManager.projectTrusted` defaults to TRUE — i.e. every project is
// auto-trusted and its `.pi/extensions`, `.pi/settings.json`, packages, etc. load
// unconditionally. Given pilot opens arbitrary paths (D12) with no tool gating (D9),
// that auto-trust is the gap this closes.
//
// MVP posture (non-interactive): honor a saved trust.json decision (parent-aware via
// ProjectTrustStore), implicitly trust the operator-chosen launch cwd, and DENY any
// other untrusted path until it's explicitly trusted. A real trust *card* surfaced to
// connected clients is the fast-follow — it needs the hub's session-swap guard reworked
// so an interactive hostUiRequest can reach clients mid-switch (trust resolves inside
// runtime.switchSession, which the hub currently runs under `switching = true`).

import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

export interface TrustInputs {
  /** Does cwd have `.pi` resources / `.agents/skills` that project trust gates? */
  hasTrustRequiringResources: boolean;
  /** Nearest saved decision for cwd or a parent (ProjectTrustStore.get), or null. */
  savedDecision: boolean | null;
  /** True only for the operator-launched PILOT_CWD (implicitly trusted). */
  isLaunchCwd: boolean;
}

/**
 * Pure trust decision. Order: nothing to gate → trust is moot; a saved decision
 * (this dir or nearest parent) wins; otherwise the launch cwd is trusted and every
 * other untrusted path is denied (deny-safe). Kept pure so every branch is testable.
 */
export function decideProjectTrust(input: TrustInputs): boolean {
  if (!input.hasTrustRequiringResources) return true;
  if (input.savedDecision !== null) return input.savedDecision;
  return input.isLaunchCwd;
}

/**
 * Build the `resolveProjectTrust` callback for one cwd-bound services instance. Reads
 * pi's live trust state (resources + trust.json) and applies {@link decideProjectTrust}.
 * Logs loudly on a denial so a missing-resource surprise is diagnosable, not silent.
 */
export function makeTrustResolver(
  cwd: string,
  isLaunchCwd: boolean,
): () => Promise<boolean> {
  return async () => {
    const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
    const savedDecision = hasTrustRequiringResources
      ? new ProjectTrustStore(getAgentDir()).get(cwd)
      : null;
    const trusted = decideProjectTrust({
      hasTrustRequiringResources,
      savedDecision,
      isLaunchCwd,
    });
    if (hasTrustRequiringResources && !trusted)
      console.warn(
        `[pilot] project trust DENIED for ${cwd} — its .pi resources won't ` +
          "load. Trust it via CLI `pi` (or ~/.pi/agent/trust.json) to enable; an " +
          "in-app trust card is a D12 fast-follow.",
      );
    return trusted;
  };
}

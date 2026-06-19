// Project-trust gate for the real pi driver (D12). pi only resolves project trust
// when the host hands the ResourceLoader a `resolveProjectTrust` callback; pass none
// and `SettingsManager.projectTrusted` defaults to TRUE — i.e. every project is
// auto-trusted and its `.pi/extensions`, `.pi/settings.json`, packages, etc. load
// unconditionally. Given pilot opens arbitrary paths (D12) with no tool gating (D9),
// that auto-trust is the gap this closes.
//
// Posture: nothing to gate → trust is moot; a saved trust.json decision (parent-aware
// via ProjectTrustStore) wins. Any untrusted path with gated resources is escalated to
// an interactive card when a client is around to answer (D12), and denied deny-safe
// otherwise (e.g. a startup resume before anyone connects). No path is implicitly
// trusted — the server's cwd carries no operator intent (see createPiDriver). A chosen
// option's trust.json updates are written through ProjectTrustStore, so decisions stay
// compatible with the CLI `pi`.

import { dirname, resolve } from "node:path";
import {
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ProjectTrustUpdate,
} from "@earendil-works/pi-coding-agent";

export interface TrustInputs {
  /** Does cwd have `.pi` resources / `.agents/skills` that project trust gates? */
  hasTrustRequiringResources: boolean;
  /** Nearest saved decision for cwd or a parent (ProjectTrustStore.get), or null. */
  savedDecision: boolean | null;
}

/** One option on the trust card, plus the trust.json mutations to apply if chosen.
 *  `updates` is empty for the "this session only" choices (decide now, persist nothing). */
export interface TrustChoice {
  label: string;
  trusted: boolean;
  updates: ProjectTrustUpdate[];
}

/** Surface the trust card and await the operator's pick. Returns the chosen option
 *  index, or null to deny (cancel / dismiss / timeout / no client connected). */
export type TrustAsk = (req: {
  cwd: string;
  title: string;
  options: TrustChoice[];
}) => Promise<number | null>;

/**
 * Pure non-interactive trust decision. Order: nothing to gate → trust is moot; a saved
 * decision (this dir or nearest parent) wins; otherwise deny (deny-safe — no path is
 * implicitly trusted). Kept pure so every branch is testable.
 */
export function decideProjectTrust(input: TrustInputs): boolean {
  if (!input.hasTrustRequiringResources) return true;
  if (input.savedDecision !== null) return input.savedDecision;
  return false;
}

/** True when the only thing standing between this cwd and a decision is the operator:
 *  it has gated resources and no saved decision. Exactly the case
 *  {@link decideProjectTrust} would otherwise deny by default. */
export function needsInteractiveTrust(input: TrustInputs): boolean {
  return input.hasTrustRequiringResources && input.savedDecision === null;
}

/**
 * Build the five trust options for `cwd`, mirroring pi's own CLI selector
 * (`getProjectTrustOptions(cwd, { includeSessionOnly: true })`, which the package
 * doesn't export). Raw paths go into the updates; `ProjectTrustStore.setMany`
 * canonicalizes them on write, so the keys match what CLI `pi` would write.
 */
export function buildTrustOptions(cwd: string): TrustChoice[] {
  const resolved = resolve(cwd);
  const parent = dirname(resolved);
  const options: TrustChoice[] = [
    {
      label: "Trust this folder",
      trusted: true,
      updates: [{ path: resolved, decision: true }],
    },
  ];
  if (parent !== resolved)
    options.push({
      label: `Trust parent folder (${parent})`,
      trusted: true,
      // trust the parent, and clear any narrower decision so the parent's wins.
      updates: [
        { path: parent, decision: true },
        { path: resolved, decision: null },
      ],
    });
  options.push({
    label: "Trust for this session only",
    trusted: true,
    updates: [],
  });
  options.push({
    label: "Don't trust",
    trusted: false,
    updates: [{ path: resolved, decision: false }],
  });
  options.push({
    label: "Don't trust (this session)",
    trusted: false,
    updates: [],
  });
  return options;
}

function warnDenied(cwd: string): void {
  console.warn(
    `[pilot] project trust DENIED for ${cwd} — its .pi resources won't load. ` +
      "Trust it from the in-app card (or CLI `pi` / ~/.pi/agent/trust.json) to enable.",
  );
}

/**
 * Build the `resolveProjectTrust` callback for one cwd-bound services instance. Reads
 * pi's live trust state (resources + trust.json) and applies the non-interactive
 * decision; when a decision is genuinely open and an `ask` channel is wired, it
 * escalates to the interactive card and persists the chosen option's trust.json
 * updates. Logs loudly on a denial so a missing-resource surprise is diagnosable.
 */
export function makeTrustResolver(
  cwd: string,
  ask?: TrustAsk,
): () => Promise<boolean> {
  return async () => {
    const store = new ProjectTrustStore(getAgentDir());
    const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
    const savedDecision = hasTrustRequiringResources ? store.get(cwd) : null;
    const input: TrustInputs = {
      hasTrustRequiringResources,
      savedDecision,
    };

    if (!ask || !needsInteractiveTrust(input)) {
      const trusted = decideProjectTrust(input);
      if (hasTrustRequiringResources && !trusted) warnDenied(cwd);
      return trusted;
    }

    const options = buildTrustOptions(cwd);
    let choice: number | null = null;
    try {
      choice = await ask({
        cwd,
        title: "Trust this project folder?",
        options,
      });
    } catch (e) {
      console.error(`[pilot] trust prompt failed for ${cwd}:`, e);
    }
    const selected =
      choice !== null && choice >= 0 && choice < options.length
        ? options[choice]
        : null;
    if (!selected) {
      warnDenied(cwd);
      return false; // cancel / dismiss / timeout → deny-safe
    }
    if (selected.updates.length > 0) store.setMany(selected.updates);
    if (!selected.trusted) warnDenied(cwd);
    return selected.trusted;
  };
}

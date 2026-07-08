---
name: dep-bump
description: >-
  Bump this repo's dependencies in a controlled, supply-chain-aware way. Two
  modes: "pi" aggressively bumps the @earendil-works/pi-* packages immediately
  (new-model support ships via pi releases), "general" bumps everything else
  behind a release-age cooldown. Use when asked to update dependencies, bump pi,
  take a new pi release, or refresh deps. Audits before AND after, runs the full
  verification gate, commits with jj. Stops loudly on any audit regression.
---

# dep-bump

On-demand, manually-triggered dependency bumping for the pantoken monorepo.

The cooldown backbone lives in the committed `bunfig.toml` (`minimumReleaseAge`,
with the four `@earendil-works/pi-*` packages excluded). This skill drives the
two bump paths over that backbone. **Run everything from the repo root** — there
is one lockfile (`bun.lock`) for the whole workspace.

## Pick a mode

- **pi** — pi is updated aggressively; new-model support ships via pi releases.
  Bumps only the `@earendil-works/pi-*` packages, no cooldown.
- **general** — everything else. Bumped deliberately, behind the cooldown.

Never bump pi and general deps in the same commit — keep the aggressive and
conservative tracks independently bisectable.

## The audit gate (shared by both modes)

`bun audit` is a known-CVE lookup against the npm advisory DB. The repo carries a
baseline of advisories we can't fix ourselves (today: undici, transitively via
pi — clears once pi bumps undici), so a plain "audit clean or STOP" gate would
jam every run. **Do not hardcode an `--ignore GHSA-…` list** — it goes stale and
would silently mask a future recurrence of those exact CVEs. Instead, diff
advisory ids before vs after the bump and trip only on **net-new** ones:

```bash
# BEFORE the bump — snapshot the baseline advisory ids.
bun audit | rg -o 'GHSA-[0-9a-z-]+' | sort -u > /tmp/dep-bump-audit-before.ids

# ... do the bump ...

# AFTER the bump — anything NET-NEW means the bump introduced a vuln.
bun audit | rg -o 'GHSA-[0-9a-z-]+' | sort -u > /tmp/dep-bump-audit-after.ids
NEW=$(comm -13 /tmp/dep-bump-audit-before.ids /tmp/dep-bump-audit-after.ids)
if [ -n "$NEW" ]; then
  echo "NEW ADVISORY introduced by this bump — STOP, do not commit:"; echo "$NEW"
  # roll back: jj restore bun.lock <touched package.json>
  exit 1
fi
```

(Piping `bun audit` loses its exit code — that's fine here, we only want the id
set. When you need a boolean "is it clean", check the exit code directly without
a pipe: `bun audit` exits 0 clean / 1 if any advisory matches, even with `--json`.)

If a net-new advisory appears: **stop, do not commit, do not work around it.**
Report it to the owner. (Repo failure philosophy: crash over silent workaround.)

## Mode: pi (aggressive, no cooldown)

**Only ONE pi package is a direct dep, and it lives in `server/package.json`:**
`@earendil-works/pi-coding-agent` (`^x.y.z`). The other three (`pi-agent-core`,
`pi-ai`, `pi-tui`) are TRANSITIVE — they follow automatically when the coding-agent
bumps. Do **not** `bun update --latest` all four from the repo root: a package named
on `bun update` that isn't a *root* direct dep gets ADDED to the root `package.json`
as a new dependency (pinning a second copy) while `server/`'s range stays put — so
the lockfile carries pi twice and the server never actually bumps. Bump at the one
declaration site instead.

```bash
# 0. Clean working copy.
jj show                                 # empty? else: jj new (or commit stale work)

# 1. Audit BEFORE → /tmp/dep-bump-audit-before.ids (see audit gate above).

# 2. Move the range at its declaration site, then let bun re-resolve. A minor bump
#    (0.79 → 0.80) crosses the ^ boundary so the range MUST move; editing is required.
#    All four pi packages are cooldown-exempt in bunfig, so a same-day release resolves.
$EDITOR server/package.json            # "@earendil-works/pi-coding-agent": "^<new>"
bun install
#    ↳ If this HARD-FAILS with "blocked by minimum-release-age": a pi TRANSITIVE dep
#      is <3d old and isn't itself name-excluded (the bunfig exclude is name-scoped, no
#      subtrees). pi is first-party/closely-followed, so override for just this resolve:
#        bun install --minimum-release-age=0
#      (CLI flag overrides bunfig; never via bunx — it's a no-op there, bun #30748.)
#      If the new sub-package is durable, also add its name to bunfig's
#      minimumReleaseAgeExcludes so future installs don't re-trip.

# 3. RE-CREATE THE pi-ai PATCH (see "The pi-ai patch" below) — the bump orphans it.

# 4. Audit AFTER → diff vs before → net-new = STOP (see audit gate).

# 5. Full verification gate — any failure = STOP, roll back.
bunx tsc --noEmit -p protocol/tsconfig.json
bun run --cwd client check
bun test
bun run test:e2e
bun run --cwd client build

# 6. Commit. A minor bump moves several files: server/package.json (range),
#    package.json (re-keyed patchedDependencies), the renamed patch file, bun.lock.
#    Review, then commit everything in the working copy (the fileset path of the patch
#    file contains @/% which break jj's fileset parser, so commit the whole change):
jj diff --git
jj commit -m "Bump pi to <new-version>; re-create pi-ai SSE patch for new file path"
```

### The pi-ai patch (don't lose it on a bump)

The repo carries a `bun patch` on **`@earendil-works/pi-ai@<version>`** (declared in the
root `package.json` `patchedDependencies` + a file under `patches/`). It rewrites pi-ai's
Anthropic SSE-streaming loop so a mid-stream socket drop is classified as a retryable
"ended before message_stop" instead of leaking the raw transport error — a real
retry-correctness fix, **not upstream** as of 0.80.2.

The patch key is **version-pinned**: bumping pi-ai orphans it (the key won't match the
new version, so bun silently stops applying it). And the target file MOVES between
releases (0.79.9 `dist/providers/anthropic.js` → 0.80.2 `dist/api/anthropic-messages.js`),
so you can't just rename the patch — re-create it against the new file:

```bash
# After step 2 (pi resolved to the new version, patch now orphaned):
bun patch @earendil-works/pi-ai            # prints the editable node_modules path
# Re-apply the SAME transform to the new file (find the `for await (const sse of
# iterateSseMessages(...))` loop in dist/api/anthropic-messages.js; replace it with the
# manual `iterator.next()` drive that distinguishes transport death from in-band errors).
# Diff the OLD patch file to see the exact before/after — the logic is unchanged.
bun patch --commit 'node_modules/.bun/@earendil-works+pi-ai@<ver>+<hash>/node_modules/@earendil-works/pi-ai'
#   ↳ pi-ai is transitive, so it lives in the .bun store, not hoisted to
#     node_modules/@earendil-works/pi-ai. `bun patch <name>` prints the right path.
#   ↳ First check upstream: if the new release already carries the fix, DROP the patch
#     (delete the patches/ file + the patchedDependencies entry) instead of re-creating.
```

`bun patch --commit` re-writes the root `package.json` `patchedDependencies` block with
BROKEN indentation (it bypasses the formatter) — fix it by hand and re-run `bun install`
to confirm the install stays consistent. Verify the patch actually applied:
`rg -c 'iterator.next' <the .bun store path>/dist/api/anthropic-messages.js`.

## Mode: general (cooldown-gated)

```bash
# 0. Clean working copy.
jj show                                 # empty? else jj new

# 1. Audit BEFORE → /tmp/dep-bump-audit-before.ids (see audit gate above).

# 2. See what's behind across the WHOLE workspace (plain `bun outdated` only
#    reports the root workspace — server/client deps are invisible without -r).
bun outdated --recursive

# 3. Bump deliberately and narrowly. DO NOT `rm bun.lock` — a cold re-resolve
#    can fail on an in-window stable dep (e.g. a freshly-published 0.0.x). Use
#    targeted updates, which re-age only what they touch (cooldown-gated):
bun update <pkg> [<pkg> ...]            # in-range refresh
#    For a major bump, take ONE at a time so breaking changes stay bisectable:
#      bun update --latest <one-pkg>
#    (As of writing, majors behind: vite 6→8, @sveltejs/vite-plugin-svelte 5→7,
#     typescript 5.9→6.0. Each is a deliberate, separate, gated decision.)

# 4. Audit AFTER → diff → net-new = STOP (see audit gate).

# 5. Full verification gate — any failure = STOP, roll back.
bunx tsc --noEmit -p protocol/tsconfig.json
bun run --cwd client check
bun test
bun run test:e2e
bun run --cwd client build

# 6. Commit only the package.json files that actually moved, plus the lockfile.
jj diff --git
jj commit <changed package.json files> bun.lock -m "Bump <deps> behind cooldown"
```

## Escape hatch: urgent security patch newer than the cooldown

When `bun audit` flags a *current* advisory whose only fix is a version younger
than the 3-day cooldown: don't lower the global `minimumReleaseAge`, don't edit
bunfig, don't route through bunx. Override the cooldown for that one resolve via
the CLI flag (verified to override bunfig, leaves no committed state):

```bash
bun audit | cat                          # confirm the advisory + the fixed version
bun update --latest <affected-pkg> --minimum-release-age=0
# then run the AFTER audit gate + full verification gate, then commit:
jj diff --git
jj commit <touched package.json> bun.lock -m "Bump <pkg> for <GHSA-id>"
```

This is a one-shot install-time bypass, never a committed bunfig change.

## Rollback

On any gate failure, restore the lockfile and manifests, working copy goes clean:

```bash
jj restore bun.lock <touched package.json>   # or `jj restore` for everything
```

## Gotchas (all verified on Bun 1.3.11)

- **Cooldown is resolution-time only** (bun #30525): a version already pinned in
  `bun.lock` isn't re-checked. So deploy / plain `bun install` honor the
  committed lockfile and are unaffected — and never `rm bun.lock` to "re-age",
  it can brick the install on an in-window stable dep.
- **Excludes are name-scoped, no subtrees, no globs**: a pi transitive dep can
  still be gated → use the `--minimum-release-age=0` recovery in pi mode.
- **`bunx --minimum-release-age` is a silent no-op** (bun #30748): only ever gate
  through `bun install` / `bun update`.
- **Global bunfig is ignored** for these keys (bun #28726): keep the setting in
  the repo's `bunfig.toml`.
- **Don't grep audit text for severity** — rely on its exit code (1 on any
  advisory) for the boolean check; use the id-diff for net-new detection.

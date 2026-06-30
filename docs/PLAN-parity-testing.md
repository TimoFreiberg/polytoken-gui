# PLAN — GUI ⇄ TUI parity test harness (Playwright + tmux)

> **Status:** design, review round 2 (revised after independent adversarial review).
> **Goal:** a reusable harness + agent-facing docs/scripts/skill that lets an agent
> drive the **pilot → polytoken GUI** and the **polytoken TUI (via tmux)** against a
> shared, isolated test project — so GUI/TUI parity can be exercised and (eventually)
> asserted automatically.

> **Doc-provenance note.** The user referenced a TODO header
> *"Full automated gui <-> tui parity testing via playwright + tmux."* That exact
> header does **not** exist in `docs/TODO.md` (the string `tmux` appears nowhere in
> `docs/`). Intent is unambiguous, so this plan proceeds; a backlog line pointing at
> this doc is added to `docs/TODO.md` so the record matches.

---

## 1. What the harness must do (from the ask)

1. Stand up a **test project** an agent can run sessions in (shared by both surfaces).
2. Launch **pilot with the real polytoken driver** on **fresh ports + isolated state**,
   so it can never touch a prod or other-test pilot/daemon.
3. Drive the **polytoken TUI via tmux** against the **same** test project + isolated state.
4. Ship **docs + scripts + a skill** so an agent *immediately* knows how to drive all of it.

The eventual payoff is automated parity assertions; the immediate deliverable is the
**drivable, isolated harness** plus the agent-facing introspection to assert on.

---

## 2. Hard constraints (verified against the live binary, not assumed)

Verified on this machine: `polytoken 0.4.0-unstable.2` (daemon OpenAPI `0.1.0`), `tmux 3.7`.
The load-bearing HTTP surface was **re-confirmed on 0.4.0** via `polytoken openapi`:
`/history`, `/state`, `/prompt`, `/events`, `/health`, `/terminate`, and
`/tui-attachment{,/claim,/heartbeat,/{lease_id}}` all still exist; daemon API is still
`0.1.0`. So the `polytoken-spike.md` (0.3.3) facts below still hold.

- **One daemon = one session = one port** (spike §1; re-confirmed). Daemon binds
  `127.0.0.1:0`, no auth.
- **The TUI-attach lease is exclusive.** `POST /tui-attachment/claim` 409s a second
  claim while one is live (spike §2; `TODO.md` 🔴 #1). Pilot's driver claims the lease
  per warm session and heartbeats it (`expires_after_seconds:30`, pid-bound).
- **The `/events` SSE has a subscriber cap** (503 when reached, spike §6).
- **⇒ The GUI and the TUI cannot both be live-attached to one daemon at once.**
  Parity is therefore **not** "open the same daemon in both and compare live streams."
  It's: both clients are *projections* of the daemon's authoritative state; we compare
  each **live** projection against the daemon ground truth, and the **other** side is
  read from its last-captured/persisted buffer (§6).
- **Pilot can open a foreign (TUI-created) session** iff both share one sessions-dir:
  `openSession(path)` resolves the id from the `session.json` path and spawns
  `daemon --resume --session-id … --sessions-dir … --global-config-dir …`
  (`polytoken-driver.ts:864`, `daemon-client.ts:213`). This is the seam the harness
  hangs on.
- **`openSession` always spawns a fresh `daemon --resume`; it never attaches an
  already-live daemon.** So a clean handoff requires the session's daemon to be **fully
  dead** on side A before side B opens it. Opening a session whose daemon is still live
  is the *coexistence* path that triggers the 409 (its own deliberate test of
  `TODO.md` #1, §7 flow 5).
- **There is NO per-session "close/end" client message.** The `ClientMessage` union
  (`protocol/src/wire.ts`) has `openSession`, `newSession`, `reloadSession`,
  `setArchived`, `abort`, … but nothing that disposes a daemon. `abort` only cancels the
  in-flight turn — the daemon stays warm, **still holding the exclusive lease.** A warm
  daemon is freed only by (a) **LRU eviction** past `warmCap` (default 8), (b) the
  **idle reaper** (default `idleReapMs` 10 min), or (c) **pilot process shutdown**.
  `createPolytokenDriver()` is called with no opts (`index.ts:124`), so both defaults
  apply. **This shapes the GUI→TUI handoff (§7 flow 4) and forces a small additive code
  change (§5, `index.ts` env plumbing).**
- **Daemon disposal is clean on SIGTERM/SIGINT, dirty on SIGKILL.** `disposeSession` →
  `DaemonClient.close()` releases the lease (`DELETE /tui-attachment/{id}`) and
  `POST /terminate`s the daemon (SIGTERM→SIGKILL fallback), and the driver's
  SIGTERM/SIGINT handler disposes *all* warm daemons (`polytoken-driver.ts:1266-1281`).
  A `kill -9` on pilot skips that → detached `new`-spawned daemons orphan. **Teardown
  MUST signal pilot with SIGTERM, never SIGKILL.**

### Isolation knobs (verified) — and what each one covers

polytoken writes **three** XDG roots, not one. `--sessions-dir` redirects **only**
`sessions/`; `logs/` + `tui_state.json` follow `XDG_DATA_HOME`; config+auth follow
`XDG_CONFIG_HOME`; the provider-catalog cache follows `XDG_CACHE_HOME`. Confirmed on disk:
`~/.local/share/polytoken/{sessions,logs,tui_state.json}` and
`~/.cache/polytoken/provider-catalogs`.

| State | Default location | Override |
|---|---|---|
| sessions registry (`session.json`, `log.jsonl`, `startup.json`) | `$XDG_DATA_HOME/polytoken/sessions` | `--sessions-dir` **and** `XDG_DATA_HOME` |
| daemon `logs/` + `tui_state.json` | `$XDG_DATA_HOME/polytoken/` | `XDG_DATA_HOME` (TUI also: `--log-dir`, **not on `attach`**) |
| global config + provider auth (`config.yaml`) | `$XDG_CONFIG_HOME/polytoken` | `XDG_CONFIG_HOME`; **`--global-config-dir` is `daemon`-only**, NOT on `new`/`attach`/`continue` |
| provider-catalog cache | `$XDG_CACHE_HOME/polytoken` (`~/.cache`) | `XDG_CACHE_HOME` |
| pilot server port | `PILOT_PORT` (8787) | `PILOT_AUTO_PORT=1` → OS-free port |
| pilot data dir | `$XDG_STATE_HOME/pilot` | per-port dir in auto-port; `PILOT_DATA_DIR` |

**Consequence (corrects the v1 table):** the TUI cannot be isolated by `--sessions-dir`
alone, and config can't be flag-isolated for the TUI at all. The harness therefore
**exports `XDG_DATA_HOME` + `XDG_CACHE_HOME` (and, if isolating config,
`XDG_CONFIG_HOME`) into every process** — the pilot server *and* every tmux pane — and
*additionally* passes `--sessions-dir` to TUI invocations as an unambiguous belt-and-
suspenders (pilot's resume path passes it anyway). Pilot inherits the env into the
daemons it spawns (`new --no-attach` sets no `env:` → inherits `process.env`).

### Precondition that WILL bite: provider auth (whole-config load failure)

`polytoken doctor` / `models` **fail outright on this machine right now**:

```
✗ config — env var $DEEPSEEK_API_KEY referenced in ~/.config/polytoken/config.yaml is not set
```

This is a **whole-config-load failure**, not a per-model one: doctor fails at the
`config` check and never reaches providers/models, so **no** model (incl. the `umans`
default) can run until the reference resolves. `config.yaml` declares `deepseek` + `umans`
(`static_key` auth). Live prod sessions prove auth *can* work here — only in a shell/app
that has the keys. **The harness must preflight a real prompt and fail loud** (§9).

---

## 3. Isolation model — one root, fresh everything

Everything lives under a single **`PARITY_ROOT`** (default
`~/.local/state/pilot-parity`, override `$PILOT_PARITY_ROOT`) so the whole harness is one
`rm -rf` from gone and provably can't touch prod:

```
$PARITY_ROOT/
  project/                 # the test project (git repo; the session cwd)
  xdg-data/                # → XDG_DATA_HOME  (polytoken sessions/, logs/, tui_state.json)
  xdg-cache/               # → XDG_CACHE_HOME (provider-catalogs; regenerable)
  xdg-config/              # → XDG_CONFIG_HOME; generated config.yaml pinning a cheap model (override: $PILOT_PARITY_CONFIG_DIR)
  pilot-data/              # pilot PILOT_DATA_DIR (push keys, archive index)
  run/<runId>/
    env                    # sourced by every helper: PARITY_ROOT, SESSIONS_DIR, the XDG_* exports,
                           #   BACKEND_PORT, VITE_PORT, GUI_URL, TMUX_SOCK, TMUX_SERVER
    pilot.pid, pilot.log
```

- **All three XDG roots are isolated; config is a generated cheap-model config.**
  `XDG_DATA_HOME=$PARITY_ROOT/xdg-data`, `XDG_CACHE_HOME=$PARITY_ROOT/xdg-cache`, **and
  `XDG_CONFIG_HOME=$PARITY_ROOT/xdg-config`** are exported into pilot **and** every tmux
  pane. Into the config dir the harness **generates a prefilled `config.yaml`** that pins a
  **cheap/fast default model** — `deepseek-v4-flash` by default, `umans-flash` via
  `PILOT_PARITY_MODEL` — declaring **only that one provider**, so test runs never burn the
  full `umans-glm-5.2` and only **one** provider key is needed (vs the real config's two).
  This matches the TODO's "tmp dir with prefilled config that sets the model to a cheap fast
  one." Auth is an env-ref (`${DEEPSEEK_API_KEY}`/`${UMANS_API_KEY}`), like the real config;
  point `$PILOT_PARITY_CONFIG_DIR` at a hand-maintained dir to override wholesale.
  *(No separate flag plumbing is needed for config isolation: pilot derives its resume
  daemon's `--global-config-dir` from its own inherited `XDG_CONFIG_HOME` via
  `defaultGlobalConfigDir()` (`daemon-client.ts:94`), so exporting `XDG_CONFIG_HOME` into
  the pilot process is sufficient for both pilot and the TUI panes.)*
- **Pilot ports.** `PILOT_DRIVER=polytoken PILOT_AUTO_PORT=1` makes the **backend** grab
  an OS-free port + per-port data dir, ignoring any inherited `PILOT_PORT`/`PILOT_DATA_DIR`
  the desktop app leaks (the mechanism `dev.ts` already implements). **Vite is the only
  exposure** (an agent needs a known URL): `up.ts` **always allocates a free port itself
  and passes it to `dev.ts` as `$PORT`** — it never lets Vite fall back to 5173 (which is
  the agent-harness's own protected dev server). Two concurrent `up.ts` runs each get
  their own free Vite + backend port; nothing pins 5173/8787.
- **tmux.** A **dedicated tmux server** via `tmux -L pilot-parity-<runId>` (its own
  socket), never the user's default server — so `kill-server` on teardown is total and
  can't disturb the user's real tmux. (Reviewer confirmed this claim is sound.)
- **The Claude_Preview path is distinct from the `up.ts` path.** The `pilot-parity`
  launch config uses Claude_Preview's `autoPort`, where **Claude_Preview** assigns Vite's
  `$PORT` and returns the landed port (as the existing `pilot` config does). Direct
  `bun parity/parity.ts up` self-allocates the Vite port instead. Both write `GUI_URL`
  to `run/env`; the skill teaches one of them per task.

---

## 4. The test project

`parity/fixtures/project/` is the seed; `parity project reset` copies it to
`$PARITY_ROOT/project` and `git init`s + commits once (VCS-aware features — trust,
worktrees — need a repo). Contents are tiny and deterministic (`README.md` with a known
first line, `hello.py`, `notes.md`) so a pinned prompt like *"reply with exactly the
first line of README.md"* has a fixed answer for assertions. It lives **outside** the
pilot repo so a driven session never nests in or mutates the pilot checkout.

**Trust.** The first session in a fresh cwd surfaces a project-trust prompt (pilot's D12
`trustResponse`; the TUI's an interrogative). The skill's first-session flows include an
explicit "answer trust" step (GUI: approve the trust card; TUI: `Y`) — this is the
baseline and works regardless. (There is no pilot- or polytoken-side trust *store* in the
repo today — only the `TrustEvent`/`trustResponse` wire shapes — so there's nothing to
pre-seed; if a pre-writable trust file turns up during implementation we can skip the
interactive step, but it's not assumed.)

---

## 5. Components (the deliverables)

New code under a top-level **`parity/`** dir (sibling to `e2e/`), TS run with `bun`,
plus a skill, docs, a launch config, and **one small additive server change**.

| Artifact | Purpose |
|---|---|
| **`server/src/index.ts` (edit)** | Plumb `PILOT_IDLE_REAP_MS` + `PILOT_WARM_CAP` into `createPolytokenDriver({ idleReapMs, warmCap })`. **Additive, defaults unchanged** (10 min / 8). Lets the harness shrink the warm-hold so a GUI→TUI handoff frees the lease promptly (§7 flow 4). Also useful for prod ops. |
| `parity/lib.ts` | Isolation env builder (the XDG_* exports), free-port alloc, `run/<id>/env` read/write, run discovery, the **`polytokenSessions()` wrapper that ALWAYS injects `--sessions-dir $SESSIONS_DIR`** (bare `polytoken sessions` lists PROD — safety-critical), daemon/gui/tui oracle helpers, daemon-port discovery (live via `polytoken sessions --sessions-dir`, else spawn-resume-read-terminate). |
| `parity/doctor.ts` | **Preflight** with the isolation env exported: `tmux`+`polytoken` on PATH, `PARITY_ROOT` writable, test project + generated config present, the chosen model's key set, and **a real prompt round-trips** via `polytoken exec` (which uses the generated cheap-model config + isolated `XDG_DATA_HOME`). Must export the isolation env into the child or it tests prod config. Fails loud with remediation: export `$DEEPSEEK_API_KEY`/`$UMANS_API_KEY`, switch `PILOT_PARITY_MODEL`, or set `$PILOT_PARITY_CONFIG_DIR`. |
| `parity/up.ts` | Run doctor; launch pilot (`PILOT_DRIVER=polytoken PILOT_AUTO_PORT=1`, isolation env, short `PILOT_IDLE_REAP_MS`, free Vite `$PORT`); gate on `/health`; write `run/env`; print `GUI_URL` + sessions-dir. |
| `parity/down.ts` | Teardown, idempotent: **SIGTERM** pilot (graceful daemon drain), then `polytokenSessions()` (always `--sessions-dir`) → `/terminate` any still-live isolated daemons, then `tmux -L <sock> kill-server`; `--purge` wipes `PARITY_ROOT`. Never SIGKILL pilot; never bare `polytoken sessions`. |
| `parity/tui.ts` | TUI driver on the dedicated tmux server, every pane spawned with the **full XDG_* env** + `--sessions-dir`. Subcommands: `new`, `attach <id>`, `continue <id>`, `keys <chord…>` (`Enter`/`C-d`/`C-c`), `type <text>`, `prompt <text>` (type+submit), `capture`, `detach` (C-d), `end` (C-c C-c **back-to-back**, then poll `polytokenSessions` until the id is gone), `ls`. |
| `parity/project.ts` | `reset` / `path`. |
| `parity/parity.ts` | One CLI dispatch (`up\|down\|doctor\|tui\|project\|oracle\|assert`) so the skill teaches one entry point. |
| `tsconfig.parity.json` (+ `bun run check`) | Typecheck `parity/` like `scripts/`/`e2e/`. |
| `.claude/launch.json` (+`pilot-parity`) | Claude_Preview config wrapping `up.ts` (autoPort feeds Vite). Agent drives the GUI via `preview_*`. |
| `.claude/skills/parity/SKILL.md` | Agent entry point: constraints, one-command workflow, flows, oracles, teardown, TUI chords. |
| `docs/PARITY-TESTING.md` | Human companion: architecture, isolation guarantees, preconditions, troubleshooting. |
| `e2e/parity.spec.ts` *(optional scaffold)* | Playwright spec **outside** the default project (must NOT inherit `PILOT_DRIVER=mock`); points at `GUI_URL` from `run/env`; `skip` unless `PILOT_PARITY_RUN` is set, so the mock suite stays green. |

### TUI chord reference (from `polytoken print-tui-command-actions`, embedded in the skill)

`submit-prompt`=Enter · `insert-newline`=Shift+Enter · `detach-session`=**Ctrl+D** ·
`end-session`=**Ctrl+C** (twice, before the flash expires) · `open-slash-palette`=`/` ·
interrogatives = `Y`/`N`/`Enter`/`Up`/`Down`/`Space`/`Tab`(edit-custom). tmux mapping:
`tmux -L <sock> send-keys -t <pane> -l "text"` (literal) · `… send-keys -t <pane> Enter`
/ `C-d` / `C-c` (chords). `end` sends the two `C-c` with no intervening delay.

---

## 6. The three oracles (corrected)

The daemon is ground truth; both clients are projections. Per §2, GUI and TUI can't both
be live-attached, so a single `assert` compares **one live client vs the daemon**, and
the other side is read from its last captured buffer / persisted state.

1. **Daemon oracle (ground truth):** `GET http://127.0.0.1:<port>/history` (+`/state`).
   Port discovery: if `polytokenSessions()` lists the id **live**, use that port; **else
   the session is cold** (e.g. just after `tui end`) — spawn a throwaway
   `daemon --resume` in the isolated sessions-dir, `GET /history`, `/terminate`. (A
   resume serves `/history` over plain HTTP; no lease needed.) **Hard gate: only
   spawn-resume when `polytokenSessions()` does NOT list the id live.** A second
   concurrent daemon on one session id is *unsupported* — it violates one-daemon-per-
   session (spike §1) and aliases the registry; that's a correctness hazard, not merely a
   lease 409 (the throwaway never claims a lease). When the id IS live, read its
   already-running port instead.
2. **GUI oracle (corrected — NOT `/debug/state`):** the **rendered DOM** via
   `preview_snapshot` / Playwright `textContent` of the transcript. `/debug/state` only
   ever returns the *landing default* (`hub.snapshot()` → `snapshotOf(defaultFocusId)`,
   `hub.ts:1747`), which under the daemon driver (no `defaultSeed`) is empty — it is **not**
   the session the agent navigated to. So the GUI projection is read from the page.
3. **TUI oracle:** `tmux -L <sock> capture-pane -p -t <pane>` → rendered text. Fuzzy
   (layout/ANSI); assert by normalized substring, not exact equality.

`parity oracle <gui|daemon|tui> [id]` prints each; `parity assert <id> <needle>` checks a
**pinned needle** (e.g. `PARITY-OK-<n>`, produced by a *"Reply with exactly: …"* prompt,
deterministic despite model noise) is present in the live client's projection **and** the
daemon ground truth, reporting which diverged.

---

## 7. Canonical flows (corrected for the no-close / lease facts)

1. **GUI-only drive.** `up` → `preview_start("pilot-parity")` → new session in test
   project (answer trust) → prompt → verify via `preview_snapshot`.
2. **TUI-only drive.** `tui new` → answer trust (`Y`) → `tui prompt "…"` → `tui capture`.
3. **Handoff parity, TUI→GUI (clean, zero-code):** `tui new` → `tui prompt "Reply with
   exactly: PARITY-OK-1"` → `tui end` (daemon **exits**, session persisted) → open that
   session in the GUI (pilot spawns a fresh resume daemon) → `parity assert <id>
   PARITY-OK-1` (GUI DOM + daemon `/history` agree). **This is the primary clean-parity
   demo — works with no code change.**
4. **Handoff parity, GUI→TUI:** new session in GUI → prompt `PARITY-OK-2` → **free the
   GUI's daemon** by either (a) `parity down` (SIGTERM pilot → drains daemons + releases
   leases; session goes cold) — *recommended, robust*; or (b) keeping pilot alive and
   waiting out the short `PILOT_IDLE_REAP_MS` the harness set. **For (b), the reaper skips
   the active/focused session and any session with a turn in flight
   (`polytoken-driver.ts:589,595`)** — so the agent must first **focus away** (open or
   create another session, so the target is no longer `activeSessionId`) AND let the turn
   finish; only then does the reaper dispose it and release the lease. (Just prompting and
   waiting will hang forever — the active session is never reaped. Without the env
   plumbing, even after focusing away it's a 10-min wait — that's why §5 adds it.) Then
   `tui continue <id>` → `tui capture` shows `PARITY-OK-2`. *(a) avoids all of this and is
   the path the skill leads with.*
5. **Coexistence / 409 (deliberate jank, tests `TODO.md` #1):** `tui new` (lease held) →
   open the *same* session in the GUI **without** detaching → observe pilot's 409
   surfacing; `tui detach` (Ctrl+D, releases lease) → retry the GUI open → recovery
   (note the ~30s lease-expiry if relying on lapse rather than explicit detach).

---

## 8. Why not just extend the existing e2e suite / mock?

The mock driver is deterministic but is *not polytoken* — it can't reveal GUI/TUI parity
gaps, which are the point. Playwright's config force-sets `PILOT_DRIVER=mock` and boots
its own server; a polytoken-backed run needs a *separate* launch (this harness) and a
*separate*, opt-in spec. So the harness lives alongside the e2e suite, not inside it, and
`bun run test:e2e` stays mock-only and green.

---

## 9. Preconditions & preflight

`parity doctor` (also the first step of `up`), with the isolation env exported into every
child it spawns: `tmux` → `polytoken` → `PARITY_ROOT` writable → test project exists →
**real prompt round-trips** in the isolated sessions-dir. The last check catches the
whole-config-load failure (missing `DEEPSEEK_API_KEY` / broken auth). On failure it prints
the exact remediation: export the key, or set `$PILOT_PARITY_CONFIG_DIR` to an isolated
config whose default model is usable here.

---

## 10. Judgment calls (surfaced)

1. **Small server edit.** Plumbing `PILOT_IDLE_REAP_MS`/`PILOT_WARM_CAP` touches
   production `index.ts`. It's additive (defaults preserved) and the cleanest way to make
   the GUI→TUI handoff prompt without a new protocol message. *Recommendation: do it;
   it's 2 lines and also a sane prod knob.* (The alternative — a full "end session"
   protocol message + driver method — is more invasive and out of scope.)
2. **Config: generated cheap-model config (RESOLVED per TODO).** ~~Earlier draft shared the
   real `~/.config/polytoken`~~ — reversed after re-reading the TODO header ("prefilled config
   that sets the model to a cheap fast one"). The harness now **generates** an isolated
   `config.yaml` pinning `deepseek-v4-flash` (default) / `umans-flash` (`PILOT_PARITY_MODEL`),
   one provider, one key. `$PILOT_PARITY_CONFIG_DIR` overrides wholesale. This also halves the
   key requirement (one provider, not two) and never burns the full model.
3. **Parity granularity.** v1 `assert` is transcript-text-contains (model-noise-tolerant);
   raw oracles exposed for stricter ad-hoc structural checks. *Rec: text-contains v1.*
4. **GUI driving.** Preview MCP / Playwright (render-faithful) for parity; WS only for
   seeding if ever needed. *Rec: preview/Playwright.*
5. **Location.** Top-level `parity/` + `tsconfig.parity.json` in `bun run check`.

---

## 11. Implementation order

1. `server/src/index.ts` env plumbing (idleReap/warmCap) — smallest, unblocks flow 4.
2. `parity/lib.ts` (isolation env, ports, run-env, `polytokenSessions` wrapper, oracles)
   + `tsconfig.parity.json`.
3. `parity/project.ts` + `parity/fixtures/project/`.
4. `parity/doctor.ts` (real-prompt preflight, env-exported) — prove auth before building on it.
5. `parity/up.ts` / `parity/down.ts` (SIGTERM, always `--sessions-dir`) + `pilot-parity` config.
6. `parity/tui.ts` (tmux driver, full XDG env per pane) + `parity/parity.ts` dispatch.
7. `parity oracle` + `parity assert`.
8. `.claude/skills/parity/SKILL.md` + `docs/PARITY-TESTING.md` + `TODO.md` backlog line.
9. End-to-end smoke (doctor → up → tui new → TUI→GUI handoff assert → down), then the
   implementation review loop.

---
name: parity
description: >-
  Drive the pilot→polytoken GUI and the polytoken TUI against one shared, isolated test
  project to exercise GUI⇄TUI parity. Use when asked to test/compare pilot-vs-TUI
  behavior, reproduce a dogfood discrepancy between the GUI and the TUI, drive a live
  polytoken session from a browser and/or tmux, or run the parity harness. Spins pilot up
  on FRESH ports with an isolated polytoken sessions registry, so it can never touch prod
  or other pilot/daemon instances. Requires provider auth in the env (see preconditions).
---

# parity — GUI ⇄ TUI parity harness

One test project, driven from two surfaces:
- **GUI:** the pilot web app backed by the **real polytoken daemon driver**, on fresh ports.
- **TUI:** the **polytoken TUI** inside a dedicated tmux server.

Everything lives under one isolation root (`$PILOT_PARITY_ROOT`, default
`~/.local/state/pilot-parity`) — fresh pilot ports, an isolated polytoken sessions
registry (`XDG_DATA_HOME`), an isolated cache, and a dedicated `tmux -L` server. It
**cannot** touch prod pilot/daemon state. Tear down with one command.

One entry point: `bun parity/parity.ts <cmd>`. See `docs/PARITY-TESTING.md` for the why.

## The model constraint that shapes everything (read this)

A polytoken daemon serves ONE session on its own port. The **TUI-attach lease is
exclusive** and the event stream is capped — so **the GUI and the TUI cannot both be
live-attached to one daemon at once**. The daemon's `/history`+`/state` is the single
source of truth; the GUI and TUI are *projections* of it. Parity = each live projection
agrees with that ground truth. Clean handoff between surfaces goes **through session
history**: fully release a session on side A before opening it on side B (there is no
per-session "close" in pilot — see flow GUI→TUI below).

## The test config (prefilled, cheap model) + preconditions

The harness generates an **isolated `config.yaml`** under the root that pins a **cheap,
fast default model** so test runs never burn the full model. Default:
**`deepseek-v4-flash`** (cheap, reliable TTFT); switch with **`PILOT_PARITY_MODEL=umans-flash`**
(free, but spiky TTFT lately). It declares only that one provider, so only **one** key is
needed — `$DEEPSEEK_API_KEY` (deepseek) or `$UMANS_API_KEY` (umans), referenced as an env
var like the real config. The live desktop app has these; a bare shell may not. Override
the whole config by pointing `$PILOT_PARITY_CONFIG_DIR` at your own dir.

**Always run `bun parity/parity.ts doctor` first.** It generates the config, checks the
chosen model's key is set, and spawns a real `polytoken exec` to confirm the model runs —
failing loud with the exact remediation (which key to export / how to switch models).

## Commands

```bash
bun parity/parity.ts doctor            # PREFLIGHT — run first (config + key + real exec)
bun parity/parity.ts doctor --quick    # skip the real exec (plumbing + key check only)
PILOT_PARITY_MODEL=umans-flash bun parity/parity.ts doctor   # swap the cheap model
bun parity/parity.ts project reset     # recreate the isolated test project (git repo)

# GUI (pilot → polytoken). Either:
#   (a) preview_start("pilot-parity")   ← easiest; gives you preview_* tools (RECOMMENDED)
#   (b) bun parity/parity.ts up         ← run BACKGROUNDED; writes run/env.json (GUI url + ports)

bun parity/parity.ts tui new           # fresh TUI session in the test project → prints session id
bun parity/parity.ts tui attach <id>   # attach TUI to a LIVE session
bun parity/parity.ts tui continue <id> # resume a COLD session into the TUI
bun parity/parity.ts tui prompt "..."  # type text + submit (Enter)
bun parity/parity.ts tui keys Y Enter  # send raw chords (see chord table)
bun parity/parity.ts tui capture       # print the rendered TUI pane
bun parity/parity.ts tui detach        # Ctrl+D: release lease, leave daemon running
bun parity/parity.ts tui end <id>      # Ctrl+C×2: terminate daemon, wait until gone
bun parity/parity.ts tui ls            # list live ISOLATED sessions

bun parity/parity.ts oracle daemon <id>  # ground-truth transcript text (live or via resume)
bun parity/parity.ts assert <id> <needle># needle present in daemon history (+ TUI pane)?

bun parity/parity.ts down              # SIGTERM pilot + /terminate isolated daemons + kill tmux
bun parity/parity.ts down --purge      # + rm -rf the whole isolation root
```

## TUI chords (for `tui keys`; from `polytoken print-tui-command-actions`)

`Enter` submit-prompt · `S-Enter` newline · `C-d` detach · `C-c` end (×2) · `/` slash
palette · `Y`/`N` interrogative yes/no · `Up`/`Down` select · `Space` toggle · `Tab`
edit-custom. `tui prompt`/`tui type`/`tui detach`/`tui end` wrap the common ones.

## Canonical flows

**0. Preflight + project (always):** `doctor` → `project reset`.

**1. Drive the GUI:** `preview_start("pilot-parity")` → new session in the test project
(approve the **trust** card on first use) → prompt → verify with `preview_snapshot`. The
GUI oracle is the **rendered DOM** (preview_snapshot / Playwright) — NOT `/debug/state`,
which only returns pilot's landing default, not the session you're driving.

**2. Drive the TUI:** `tui new` (prints id) → if a trust prompt shows, `tui keys Y` →
`tui prompt "..."` → `tui capture`.

**3. Parity TUI→GUI (clean, recommended):**
`tui new` → `tui prompt "Reply with exactly: PARITY-OK-1"` → wait → `tui end <id>`
(daemon exits, session persisted) → open that session in the GUI → it should render the
same transcript → `bun parity/parity.ts assert <id> PARITY-OK-1` (daemon ground truth)
and confirm the GUI DOM via `preview_snapshot`.

**4. Parity GUI→TUI:** new session in the GUI → prompt `PARITY-OK-2` → **free the GUI's
daemon** with `down` (SIGTERM frees the exclusive lease; session goes cold) — *this is the
robust path* — then `tui continue <id>` → `tui capture` shows `PARITY-OK-2`. (There is no
GUI "close session" button; the harness sets a short `PILOT_IDLE_REAP_MS` so an *un-focused,
idle* session also self-frees, but you must focus away first for the reaper to act — `down`
is simpler.)

**5. Coexistence / the 409 (reproduces TODO.md #1):** `tui new` (lease held) → open the
SAME session in the GUI **without detaching** → observe pilot's 409 → `tui detach` → retry
the GUI open → recovery (or wait ~30s for the lease to lapse).

## Teardown (always, when done)

`bun parity/parity.ts down` (add `--purge` to wipe the root). If you launched the GUI via
`preview_start`, also `preview_stop`. `down` only ever touches the isolated registry +
the dedicated tmux server + the pilot pid it recorded — it can't reach prod.

## Gotchas

- **One TUI session at a time** (the `tui new` "newest session" detection assumes it).
- A daemon that fails to start leaves its error in the pane — `tui capture` shows it.
- `tui` and `oracle`/`assert`/`down` ALWAYS scope `polytoken sessions` to the isolated
  `--sessions-dir`; never run a bare `polytoken sessions` (it lists PROD daemons).

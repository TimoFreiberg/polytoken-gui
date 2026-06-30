# Parity testing — GUI ⇄ TUI (human companion)

Operator/troubleshooting view of the parity harness. The **agent-facing** runbook is the
`parity` skill (`.claude/skills/parity/SKILL.md`); the **design trail + adversarial-review
record** is [`PLAN-parity-testing.md`](PLAN-parity-testing.md). This page is the "what it is
+ what breaks" middle.

## What it's for

Drive **one shared test project** from two surfaces — the **pilot GUI** backed by the real
**polytoken** daemon driver, and the **polytoken TUI** in tmux — to exercise GUI⇄TUI parity:
enumerate the features the TUI exposes and find divergences/jank/missing features in pilot
(the TODO header *"Full automated gui <-> tui parity testing via playwright + tmux"*). The
harness is the infra; the feature-exploration runs are an agent *using* it.

## Architecture in one breath

A polytoken daemon serves **one session on one port**; its TUI-attach lease is **exclusive**
and its event stream is capped, so the GUI and TUI **can't both be live-attached to one
daemon at once**. The daemon's `/history`+`/state` is the single source of truth; the GUI
(rendered DOM) and TUI (tmux pane) are projections. Parity = each live projection agrees
with that ground truth; clean handoff between surfaces goes **through session history**
(fully release one side before opening the other — there is no per-session "close" in pilot).

## Isolation guarantees (why it can't touch prod)

Everything lives under one root — `$PILOT_PARITY_ROOT` (default `~/.local/state/pilot-parity`):

| Concern | How it's isolated |
|---|---|
| pilot ports | backend = OS-assigned free port; Vite = a free port the harness picks (never 5173/8787) |
| pilot data dir | `$ROOT/pilot-data` (own PID-lock, push keys, archive index) |
| polytoken sessions/logs/tui_state | `XDG_DATA_HOME=$ROOT/xdg-data`, exported into pilot **and** every tmux pane (+`--sessions-dir`) |
| polytoken provider-catalog cache | `XDG_CACHE_HOME=$ROOT/xdg-cache` |
| polytoken config + model | `XDG_CONFIG_HOME=$ROOT/xdg-config` with a **generated** config (below) |
| tmux | a dedicated `tmux -L pilot-parity-<hash>` server, never the user's default |

`bun parity/parity.ts down --purge` removes the whole root. Teardown only ever touches the
isolated registry, the dedicated tmux server, and the recorded pilot pid — verified to leave
prod polytoken sessions intact.

## The generated config (cheap model)

So test runs never use the prod default, the harness writes
`$ROOT/xdg-config/polytoken/config.yaml` pinning a **(full, mini) model pair** from one
provider (so only one key is needed). polytoken enforces tiers: `defaults.full` must be a
**Full**-tier model (the agent's main model), `defaults.mini` a **Mini**-tier one — so a
cheap model like `deepseek-v4-flash` (Mini-only) can only be the *mini*. Presets
(`PILOT_PARITY_MODEL`):

- **`deepseek`** (default) — full `deepseek/deepseek-v4-pro`, mini `deepseek/deepseek-v4-flash`. `$DEEPSEEK_API_KEY`. Metered but cheap.
- **`umans`** — full `umans/umans-glm-5.2`, mini `umans/umans-flash`. `$UMANS_API_KEY`. Flat-rate/unlimited (cost-free, just slower).

For a custom same-provider pair, set both `$PILOT_PARITY_FULL` + `$PILOT_PARITY_MINI`
(`provider/model` refs). Auth is an env-ref like the real config — the live desktop app has
the keys; a bare shell may not. Override the whole config via `$PILOT_PARITY_CONFIG_DIR`.
`default_permission_matcher: bypass_plus` (unattended-friendly); switch the runtime
permission monitor to exercise approval popups.

## Quickstart

```bash
bun parity/parity.ts doctor          # preflight: tmux/polytoken/project/config/key + real exec
bun parity/parity.ts tui new         # drive the TUI (prints the session id)
bun parity/parity.ts tui prompt "Reply with exactly: PARITY-OK-1"
# drive the GUI: preview_start("pilot-parity")  (or `bun parity/parity.ts up`, backgrounded)
bun parity/parity.ts assert <id> PARITY-OK-1    # daemon ground truth contains the needle
bun parity/parity.ts down --purge    # tear down + wipe
```

Full command list + the canonical handoff/coexistence flows: the `parity` skill.

## Troubleshooting

- **`doctor` fails at "provider key set" / "model usable".** The chosen model's key isn't in
  the env. Export `$DEEPSEEK_API_KEY` (or `PILOT_PARITY_MODEL=umans-flash` + `$UMANS_API_KEY`),
  or point `$PILOT_PARITY_CONFIG_DIR` at a working config. Without a key the whole config
  fails to load and **no** daemon starts — `tui new` will time out and `tui capture` shows the
  config error.
- **`tui new` times out.** Run `bun parity/parity.ts tui capture` — the pane is kept alive on
  exit, so a daemon startup error (usually the missing key) is visible there.
- **GUI opens a TUI-held session and 409s.** Expected — the lease is exclusive (this is the
  coexistence flow). `tui detach` (Ctrl+D) or wait ~30s for the lease to lapse, then retry.
- **GUI→TUI handoff: `tui continue` collides with a live daemon.** Free the GUI's daemon
  first: `bun parity/parity.ts down` (SIGTERM releases the lease) — or, keeping pilot alive,
  focus a *different* session and wait out the short `PILOT_IDLE_REAP_MS` (the reaper skips
  the active/in-flight session).
- **GUI URL.** Both pilot's backend and Vite are bound to `127.0.0.1`, and `guiUrl` in
  `$ROOT/run/env.json` uses it — reachable by curl and a browser alike (no IPv6/`::1`
  ambiguity).
- **Two harnesses at once.** Give each its own `$PILOT_PARITY_ROOT` (separate ports, sessions,
  tmux socket, everything).

## Files

`parity/` — `parity.ts` (CLI), `lib.ts` (isolation env, oracles, config gen), `doctor.ts`,
`launch.ts` (GUI), `tui.ts` (tmux), `down.ts`, `project.ts`, `fixtures/project/`. Launch
config `pilot-parity` in `.claude/launch.json`. One additive server edit:
`PILOT_IDLE_REAP_MS`/`PILOT_WARM_CAP` env plumbing in `server/src/index.ts` + `config.ts`.

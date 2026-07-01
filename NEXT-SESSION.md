# NEXT SESSION — pilot ⇄ polytoken parity: verified findings + fix plan

Start-here handoff for the next session. This is the **source-verified** distillation of the
GUI⇄TUI parity audit (2026-06-30/07-01). Every claim below was checked against `server/`,
`client/`, `protocol/` source by an independent pass; where it corrects the earlier empirical
write-up, that's called out.

**Companion docs:**
- [`polytoken-features.md`](polytoken-features.md) — authoritative inventory of what polytoken/TUI expose.
- [`pilot-feature-state.md`](pilot-feature-state.md) — the empirical GUI audit (see *Corrections* §D below — a few rows are imprecise; this doc supersedes where they differ).
- Journal entry: `~/agent-journal-staging/2026-06-30T212315Z-driving-the-pilot-gui-via-preview.md` (the harness env-key gotcha).

---

## A. First: how to actually drive the pilot GUI (don't rediscover this)

`preview_start("pilot-parity")` is "RECOMMENDED" in the skill but **does not work out of the
box** — the preview server process never sources `~/.zshenv`, so it lacks `$UMANS_API_KEY` /
`$DEEPSEEK_API_KEY`; the daemon spawn + `polytoken models` fail with `env var … is not set`,
the model picker stays empty, and sessions can't be created. Bash tool calls have the keys;
the preview server doesn't.

**Reliable startup sequence:**
1. `bun parity/parity.ts down --purge` (wipe any stale config — the harness only writes
   `config.yaml` when absent, `parity/lib.ts:241`, so a stale one survives a `lib.ts` fix).
2. `PILOT_PARITY_MODEL=umans bun parity/parity.ts doctor` (umans = free/$0; deepseek's Full
   model is metered). Confirm green.
3. Inline the key into the isolated config so the preview-spawned daemon needs no env var:
   `KEY="$UMANS_API_KEY" perl -0pi -e 's/\$\{UMANS_API_KEY\}/$ENV{KEY}/g' ~/.local/state/pilot-parity/xdg-config/polytoken/config.yaml`
   *(or launch the GUI under a shell that sources `~/.zshenv`.)*
4. `preview_start("pilot-parity")` — **restart it if it was already up** before the config
   fix: the hub caches the failed `listModels` and only refetches on restart, not on reload.
5. In the GUI, scope new sessions to the project dir via the composer's `Project:` chip →
   the **recent "project" chip** (fastest), then send. `bypass_plus` means no approval
   prompts fire (see §C to exercise the permission card).
6. Teardown: `preview_stop` + `bun parity/parity.ts down --purge` (also wipes the inlined key).

**Better long-term fix:** make `preview_start` launch the GUI under a `~/.zshenv`-sourcing
shell, or have the harness always regenerate `config.yaml`. Worth doing so parity runs "just
work."

---

## B. Fix to-do — ordered by impact, with exact fix sites + repro

### B1. 🟢 `goal_proposal` interrogative wedges the session — FIXED
- **What:** daemon 0.4.x emits an `interrogative` of type `goal_proposal` (from `/goal set`
  or an agent `propose_goal`). Pilot's vendored `InterrogativeType` (`wire-types.ts:1545`) is
  `permission|confirmation|clarification|capability|plan_handoff` — **no `goal_proposal`**. It
  hits the `default:` arm of `buildInterrogativeMapping` (`event-map.ts:429-453`), which emits
  a fire-and-forget `notify` ("Unrecognized interrogative type: goal_proposal") and returns
  `pending:null` — **it POSTs no cancel/answer**, so the daemon's turn stays blocked. Pilot's
  "Working" indicator is hub-authoritative, slaved to the daemon's `turn_in_flight`
  (`polytoken-driver.ts:260-262`), so it stays lit; a page reload re-derives running from
  `GET /state` and can't self-heal. (Empirically abort didn't clear it either — that's a
  daemon behavior for interrogative-blocked turns; worth confirming daemon-side.)
- **Fix:** regenerated `wire-types.ts` from the live 0.4.x daemon (`polytoken openapi`).
  Added `case "goal_proposal":` in `buildInterrogativeMapping` — renders a `confirm` card
  (Accept/Reject) from the `GoalProposalContext` (title + proposed_summary). Added
  `case "goal_proposal":` in `buildInterrogativeResponse` — maps `{confirmed}` →
  `{kind:"goal_proposal_answer", accepted: boolean}`. Made the `default:` arm deny-safe:
  emits a blocking `confirm` dialog (not a fire-and-forget `notify`) with
  `requestId == interrogative_id`, registers the pending, and `case "unknown"` in
  `buildInterrogativeResponse` returns `{kind:"cancel"}` for ANY response — so any future
  unknown interrogative type can be dismissed to unblock the daemon's turn. Also added
  `bypass_plus` to `PermissionMonitorMode`, and new DaemonEvent variants
  (`goal_driver_update`, `agent_block_violation`, `usage_throttle`) to the `return EMPTY`
  list.
- Then add goal *display* (open TODO: polytoken shows "(goal)" by the facet).

### B2. 🔴 Whole Settings/trust areas are mock-only (dead vs the real daemon)
- **What:** the live `polytoken-driver.ts` object literal (`:678-1278`) implements 24 methods
  and **omits 15** that exist in `mock-driver.ts`, so they pass e2e (mock) but are dead live:
  `getTree, clearQueue, listExtensions, setExtensionEnabled, listProviders, setProviderApiKey,
  removeProviderApiKey, oauthLogin, oauthLogout, setDefaultModel, setDefaultThinking,
  setFavoriteModels, subscribeTrust, respondTrust`. The hub guards each with `?.`/early-return;
  most fail **silently** (tree hangs, Providers/Extensions show empty, trust card never fires),
  except `clearQueue` (`hub.ts:1391`) and `oauthLogin` (`hub.ts:1006`) which send an error toast.
  **Note 2026-07-01:** `getTree` no longer applies — the tree view was removed entirely.
  The count is now 13 mock-only methods (B3 is obsolete).
- **Fix:** implement the 14 mock-only methods in the polytoken driver literal against the
  daemon (auth.json/global-settings for providers/OAuth/defaults, extension loader for
  extensions, and see B3 for tree).
- **⚠️ correction to the old matrix:** `setClientPresence` is **not** mock-only — it's a
  *dangling optional* implemented **nowhere** (only `driver.ts:283` decl + `hub.ts:322`
  call-site + a test stub). The polytoken driver's own trust-prompt doc (`driver.ts:276-283`)
  *needs* it to deny-safe when no client is connected, so implement it there too.

### B3. 🔴 Session-tree view hangs on "Loading tree…" — **OBSOLETE (removed)**
- **What:** `getTree` unimplemented → `hub.ts:882` (`sendTree`) early-returns with no
  `treeState`; the client only clears its loading state on `treeState`
  (`TreeView.svelte:193`), so it hangs forever. Same guard disables the post-branch tree
  refresh (`hub.ts:901`). (`polytoken-driver.ts` even keeps a dead `TreeSnapshot` import.)
- **Fix:** implement `getTree(sessionId?)` in the polytoken driver by projecting the daemon's
  tree (note: **the daemon has no `/tree` HTTP endpoint** — build it from `GET /history`).
  Defense-in-depth: have `sendTree` emit an explicit empty/"unsupported" `treeState` (or the
  client time out) so it degrades instead of hanging.
- **Obsolete 2026-07-01:** the entire tree view was removed — `getTree`, `sendTree`,
  `treeState`, `queryTree`, `TreeView.svelte`, `tree-view.ts`, and the `TreeSnapshot`/
  `TreeNodeInfo`/`TreeNodeKind` types no longer exist. The daemon's history is linear
  (`POST /rewind` destructively truncates), so the branching tree was fiction. The inline
  rewind buttons + `⌘⇧↑` hotkey in Transcript.svelte stay (they use `store.branch` →
  `POST /rewind` directly, independent of the tree view).

### B4. 🔴 Mid-turn "steer/follow-up" doesn't queue — it starts a new turn (real bug)
- **What:** stronger than "cosmetic toggle." Both steer *and* follow-up call `POST /prompt`
  (`polytoken-driver.ts:705-707`); **`/turn/input` is never called** (`queueTurnInput`,
  `daemon-client.ts:702`, has zero callers). So a mid-turn send attempts a fresh turn and is
  **rejected 409** if one is in flight, instead of queuing.
- **Fix site:** `polytoken-driver.ts:707` — when a turn is active, call
  `ws.client.queueTurnInput(text)` instead of `.prompt(text)`. Then either wire `deliverAs`
  to something real or delete the SegmentedControl (`docs/TODO.md:25-42`).
- **Repro:** while a turn streams, type + Enter → routed to `/prompt`, 409.

### B5. 🟠 "Branch from this prompt" = irreversible one-click history deletion, no guard
- **What:** `branchFrom` → `POST /rewind` (`polytoken-driver.ts:998-1030`), which "drops the
  target prompt and everything after." The button is labeled *Branch* and there is **no
  confirmation dialog** anywhere on the path (`Transcript.svelte:697` → `store.branch`
  `store.svelte.ts:1463` → `/rewind`).
- **Fix:** add a destructive-confirm gate (`Transcript.svelte:697` or `store.branch`) **and**
  relabel tooltip/aria (`Transcript.svelte:702-704`) to
  "Rewind — deletes everything after this point."

### B6. 🟠 Permission-monitor MODE has no UI
- **What:** no control to view/switch `standard|bypass|autonomous`. `daemon-client.ts:813`
  `setPermissionMode` exists but is **dead code** (zero call-sites); no `GET /permission-monitor`
  read; no driver method. Urgent TODO ("show + edit permission level next to model/effort").
  *(The permission approval **card** is fine — see §C — this is only the mode selector.)*
- **Fix:** add a `PilotDriver` permission-monitor read/switch method (wrap the existing
  `setPermissionMode` + a GET), relay through the hub + `foldEvent` (there's a
  `permission_monitor_switch` event), and a bottom-bar control.

### B7. 🟡 Right-side sidebar (todos / jobs / flagged files) — TUI parity
- **What:** daemon ships the data; pilot drops it. `SessionStateSnapshot.flags[]` and
  `.todos[]` are on every `/state`; jobs come from `/jobs` + `job_*` events. `protocol/src/
  state.ts` `SessionState` carries none of them. Pilot's only todo affordance is the composer
  "Open tasks" pill, which reads the ambient **`tasklist` widget** (`tasklist.ts`,
  `Composer.svelte:87`) — **not** the structured `todos` snapshot.
- **Fix:** extend `SessionState` (`state.ts:109`) + `SessionSnapshot` with flags/todos/jobs;
  populate in `snapshotFromState` (`event-map.ts:228`); stop returning EMPTY for `job_*`
  (`event-map.ts:1089`); fold in `foldEvent`; render a right rail. (Daemon also has
  `DELETE /todos/{id}` for a manage affordance.)

### B8. 🟡 Images are silently dropped by the live driver
- **What:** client image pipeline is real (compress/paste/drag-drop/heic), but
  `polytoken-driver.ts:688` drops the `_images` param and the daemon `/prompt`/`PromptRequest`
  has no image channel — so attaching images is a **silent no-op** live.
- **Fix:** check whether the daemon protocol supports content blocks
  (`wire-types.ts PromptRequest`); if so, wire images through; if not, surface an "images not
  supported" hint instead of silently dropping.

### B9. 🟢 Plan-review signals are surfaced
- **What:** plan doc + `plan_handoff` approve are solid (tested). The plan-reviewer
  subagent verdict and `plan_review_required`/`plan_mode_reinforcement`/`plan_verification`
  nudges now surface as visible inject pills (`event-map.ts:1022`) — the operator sees
  a "Plan review required" (etc.) pill that expands to the reminder body. Previously
  these were folded into `display:false` — the operator got no signal.
- **Fix:** branched on `ev.reason.type` in the `system_reminder` case; plan-review
  reasons get `display:true` with a human-readable label, all others stay `display:false`.

### B10. 🟢 Minor
- **New-session spurious error:** `newSession` applies the model on create even when it equals
  the default → `POST /model` 409 `no_change` logged as error. Fix in `daemon-client.ts`
  `setModel` (`:767-771`): treat 409 whose `ErrorBody.code === "no_change"` as success — but
  note `post()` (`:524`) reads a nonexistent `error` field; must read parsed `data.code`
  (`ErrorBody` uses `code`/`message`, `:1365-1370`). 409 also means `turn_in_flight`/
  `edit_format_locked`, so key on the **code**, not the status.
- **Login-shell env is now wired live:** `captureLoginEnv` runs at polytoken-driver
  construction, spawns `<shell> -l -c 'env'` (login only, not interactive), and passes
  the result as `env` to every daemon spawn (login env wins over pilot's launchd PATH).
  `getLoginEnvStatus` reports the captured state; the "restart to apply" logic in
  `hub.ts` compares the resolved shell to the active one.
- **Background model is still dead-by-design:** `backgroundModel` only drives Settings
  display text + a warning (resolved against the cached model list); it is never
  forwarded to the out-of-process daemon. Wire it at daemon spawn/attach or label it
  clearly as display-only.
- **Archive UX:** the dirty-worktree reap path *is* wired live (not mock-only) and shows a
  "Worktree kept" toast; polish gaps: no pre-click warning that Archive reaps a clean
  worktree (`Sidebar.svelte:850`), and a warm-rename failure is silently swallowed
  (`polytoken-driver.ts:982`).

---

## C. What's verified-good (don't re-audit)

- **Core loop:** prompt → stream → tool cards → completion; markdown/inline-code render well.
- **Model picker:** searchable, provider-grouped, favorites, keyboard nav. `setModel`/thinking work.
- **`ask_user_question` card:** first-class; full answer round-trip verified live.
- **All 6 interrogative types are handled** (`permission, confirmation, clarification,
  capability, plan_handoff, goal_proposal`) — the `never` guard at `event-map.ts:439` enforces exhaustiveness
  (a future 7th type breaks the build there). The `default:` arm is now deny-safe: it renders
  a blocking `confirm` dialog and returns `{kind:"cancel"}` for any response, so an unknown
  type can be dismissed to unblock the daemon's turn instead of wedging it.
- **Permission approval card:** code-complete + mock fixture + desktop/mobile e2e. Renders the
  daemon-pruned scope subset (usually ~3, up to 7 in the no-rule fallback). Only doesn't fire
  live because the parity config is `bypass_plus`. To see it: `PILOT_DRIVER=mock`, `/?dev`,
  drive the `permission` script. (Nit: "Deny" is radio option[0] inline, no visual separation.)
- **Sessions:** create (project-grouped sidebar, DirPicker w/ recents + path-mode + statPath +
  worktree toggle), list/search/active-only, rename/archive/unarchive (+dirty-worktree),
  `reloadSession` recovery, multiple concurrent daemons.
- **Context meter, facet toggle** (binary execute↔plan — can't reach a 3rd custom facet),
  thinking-level picker, Settings Appearance/Notifications, Web Push (verified on iPhone).
- **Slash menu** surfaces the full command set (BUILTIN), routes `/name args` as a prompt;
  `/model` omitted (native picker). Caveat: TUI-only
  commands (`/detach /inputdebug /refresh /quit`) are listed but meaningless in a web UI;
  routing ≠ rich result rendering (e.g. `/jobs`, `/todo`, `/help`).

---

## D. Corrections to `pilot-feature-state.md` (known imprecisions in that doc)

1. Capability matrix lists `setClientPresence` as mock-only → it's **unimplemented everywhere**
   (dangling optional). `subscribeTrust`/`respondTrust` *are* mock-only, as stated.
2. `clearQueue`/`oauthLogin` are described as silent no-ops → they actually **surface an error
   toast** (`hub.ts:1391`, `:1006`); the *silent* failures are getTree/providers/extensions/trust.
3. Steer/follow-up: doc implies both hit `/turn/input` → in fact both hit `/prompt`;
   `/turn/input` is never called (see B4). Stronger bug than described.
4. Image attachments row (🟡 "not exercised") → live driver **drops images** (B8): a functional
   no-op, not merely untested.
5. Environment row (was 🟡 "not exercised") → login-shell is now **wired live** at daemon
   spawn (B10 updated); background-model remains display-only.
6. Todos pill "fed by parsing `todo_*` tool calls" → actually fed by the ambient **`tasklist`
   widget** (B7).
7. Plan-mode ("machinery represented") — review signals now surface as inject pills (B9 🟢).
8. Permission card "7-choice" → usually pruned to ~3; all 7 only in the no-rule fallback.

---

## E. Still unverified (honest gaps)

- The "abort can't recover a `goal_proposal`-wedged turn" leg was an *observed daemon* behavior.
  Now mitigated pilot-side: the deny-safe default arm lets the operator dismiss any interrogative
  to POST `{kind:"cancel"}`, unblocking the turn without needing abort. Whether `/turn/cancel`
  *also* cancels an interrogative-blocked turn is still a daemon-side question.
- Project-trust flow with a genuinely **untrusted** dir (parity config was `bypass_plus` +
  pre-trusted, so the trust path never fired live). Needs a clean untrusted-dir test.
- Compaction (`/compact`) progress rendering, `/clear`, `/reset-shell`, `/daemon-reload`,
  MCP `/mcp` management, `/title` — only slash-passthrough was reasoned about, not driven live.

# pilot — feature-state vs polytoken (GUI⇄TUI parity)

> ⚠️ **A follow-up source-verification pass corrected a few rows here.** See
> [`NEXT-SESSION.md`](NEXT-SESSION.md) §D for the corrections (notably: `setClientPresence`
> is unimplemented *everywhere* not mock-only; steer/follow-up both hit `/prompt` and never
> queue; images are silently *dropped* live; login-shell env is now wired live at daemon
> spawn; the todos pill reads the ambient `tasklist` widget) and §B for exact fix sites + repro recipes.

For each polytoken feature (see [`polytoken-features.md`](polytoken-features.md)): does **pilot
support it properly** — reliably, no jank, good UX?

**How this was checked:** the parity harness (`bun parity/parity.ts`) on fresh isolated
ports, model `umans/umans-glm-5.2`. The pilot GUI was driven live via `preview_start
("pilot-parity")` (real polytoken daemon driver), cross-checked against the daemon's
`/history`+`/state` ground truth and against pilot's source. "Empirical" = observed in the
running GUI; "code" = grounded in `server/`/`client/` source.

### Legend
- ✅ **Good** — works, reliable, good UX
- 🟡 **Partial / janky** — works but with rough edges, weaker UX than the TUI, or untested-edge risk
- 🔴 **Broken / missing** — non-functional against the live daemon, or absent

---

## TL;DR — the headline findings

1. 🟢 **Goals were broken and wedged the session — FIXED.** Setting a goal (`/goal set …`,
   or any agent `propose_goal`) makes the daemon emit a **`goal_proposal` interrogative**,
   which pilot previously didn't recognize — it rendered **"⚠ Unrecognized interrogative
   type: goal_proposal"** and the turn got **stuck in "Working…" permanently**. **Fixed:**
   `wire-types.ts` regenerated from the live 0.4.x daemon; `goal_proposal` now renders a
   `confirm` card (Accept/Reject) and maps to `goal_proposal_answer{accepted}`. The
   `default:` arm is now deny-safe — any future unknown interrogative type renders a
   blocking dialog that dismisses to `{kind:"cancel"}`, so no unknown type can wedge the
   session again.
2. 🔴 **Whole feature areas are implemented only in the mock driver, not the live polytoken
   driver** — so they pass e2e (mock) but are dead against the real daemon: **Providers / API
   keys / OAuth, Extensions, global model defaults & favorites, and the
   project-trust card.** (Capability matrix below.)
3. ✅ ~~🔴 **Session-tree view hangs on "Loading tree…" forever**~~ — **Removed 2026-07-01.**
   The entire tree view was deleted (the daemon's history is linear — `POST /rewind`
   destructively truncates, it doesn't branch). `getTree`, `treeState`, `TreeView.svelte`,
   and all tree types are gone. The inline rewind buttons + `⌘⇧↑` hotkey stay.
4. 🟡 **"Branch from this prompt" is actually a destructive rewind.** `branchFrom` maps to
   `POST /rewind`, which "drops the target prompt and everything after" (`polytoken-driver.ts:1009`).
   The button says *Branch*; the daemon does a *destructive rewind*.
5. ✅ **The core loop is solid:** prompt → stream → tool cards → completion, the model picker,
   `ask_user_question` approval cards, the slash menu, context meter, and session management
   all work well.

### Driver capability matrix (live polytoken driver)

`PilotDriver` methods the **live** `polytoken-driver.ts` implements vs omits (omitted ones
exist only in `mock-driver.ts`, so the hub guards them with `?.`/early-return and the GUI
shows empty/loading):

| Implemented (live) | Omitted (mock-only ⇒ dead in GUI) |
|---|---|
| prompt, abort, respondUi, subscribe | ~~`getTree`~~ (removed), `listProviders`, `setProviderApiKey`, `removeProviderApiKey` → Providers tab empty |
| listSessions, openSession, newSession | `listProviders`, `setProviderApiKey`, `removeProviderApiKey` → Providers tab empty |
| branchFrom (=rewind), reloadSession, defaultSeed | `oauthLogin`, `oauthLogout` → OAuth sign-in dead |
| renameSession, setArchived, cleanupWorktree | `listExtensions`, `setExtensionEnabled` → Extensions tab empty |
| getUsage, getModelDefaults | `setDefaultModel`, `setDefaultThinking`, `setFavoriteModels` → can't write global defaults |
| listModels, listCommands | `subscribeTrust`, `setClientPresence`, `respondTrust` → trust card never fires |
| setModel, setThinking, setFacet | `clearQueue` → queue-clear is a no-op |
| listFileIndex, listFiles, listDir, statPath | |

---

## Per-area assessment

### 1. Conversation & turn lifecycle

| Feature | State | Evidence |
|---|---|---|
| Send prompt | ✅ | Created a session + got streamed reply `PARITY-OK-1`. Composer, send, user/assistant bubbles all clean. |
| Streaming text | ✅ | Tokens stream; markdown + inline code render well ("Done: created both todos and ran `echo …`"). |
| Thinking block | 🟡 | `ThinkingBlock.svelte` + a "Hide thinking blocks" toggle (default **On**) exist; thinking folds into the collapsed "Worked for Ns" summary. Present, not separately spot-verified live. |
| Tool-call cards | ✅ (live) / 🟡 (settled) | While streaming, each tool renders as a clean one-line card: bold name + input + duration + green/✓ status + expand chevron (`todo_create {…}`, `shell_exec echo …`). **But** on turn completion they **collapse into one opaque "Worked for 1m 10s"** — the over-merge the team already flagged (TODO: "Stop merging subsequent tool calls"). Hides distinct steps. |
| Mid-turn queue (steer/follow-up) | 🟡 | A `steer \| follow-up` SegmentedControl + "Queue a message…" appears mid-turn ("Enter sends as selected · Alt+Enter queues a follow-up"). **The toggle is cosmetic** — the daemon's `POST /turn/input` has no steer/followup discriminator (`daemon-client.ts`), so both do the same thing. Known TODO + suspected steer bug. |
| Abort / Stop | 🟡 | "■ Stop" button cancels a normally-streaming turn. (Previously could not recover a `goal_proposal`-wedged turn — now fixed; the deny-safe default arm lets any interrogative be dismissed.) |
| Context meter | ✅ | Bottom-bar ring + "%" updates per turn (`getUsage` implemented). |
| Compaction (`/compact`) | 🟡 | Only via slash passthrough; `compaction_*` events fold into the transcript, but there's no dedicated "compact" affordance or progress UI. |
| Clear context (`/clear`) | 🟡 | Slash passthrough only; no dedicated button. |

### 2. Rewind / branch / tree

| Feature | State | Evidence |
|---|---|---|
| Session-tree view | ~~🔴~~ ✅ Removed | **Removed 2026-07-01** — the daemon's history is linear (`POST /rewind` destructively truncates), so the branching tree was fiction. `getTree`, `TreeView.svelte`, `tree-view.ts`, and all tree protocol types are deleted. The inline rewind buttons + `⌘⇧↑` hotkey stay. |
| Per-prompt rewind | 🟡 | "Branch from this prompt" exists per user message and routes to `POST /rewind`. Functional, **but it's a destructive rewind mislabeled as "Branch"** (`polytoken-driver.ts:1009`: "NOT a branch — it's a destructive REWIND"). No non-destructive branching. |

### 3. Models / reasoning / facets / permissions

| Feature | State | Evidence |
|---|---|---|
| Model picker | ✅ | Excellent: searchable, provider-grouped ("UMANS 2"), shows active model, favorites, kbd hints (`↑↓ move · ↵ select · esc cancel`). Per-session `setModel` works. |
| Reasoning/thinking level | ✅ | "high" badge in the bar; `ModelPicker` thinking levels with `⌘⇧E`. |
| Facet switch | 🟡 | `FacetBadge` is a **2-way toggle** (execute↔plan). Fine for the 2 shipped facets, but the TUI offers a facet **typeahead/menu** — pilot can't reach a 3rd+ custom facet. |
| **Permission monitor mode** | 🔴 | No UI to show/switch the mode (standard/bypass/bypass_plus/autonomous). Only `/permissions` text passthrough. Urgent TODO ("show + edit permission level… next to model and effort"). The permission *approval cards* work (see §4); the *mode control* is missing. |
| Set global default model / thinking / favorites | 🔴 | `Settings ▸ Models` can **read** defaults (`getModelDefaults`) but **can't write** them — `setDefaultModel`/`setDefaultThinking`/`setFavoriteModels` are mock-only. |

### 4. Approvals / interrogatives

| Interrogative type | State | Evidence |
|---|---|---|
| `ask_user_question` | ✅ | **First-class card**: title, subtitle, radio options with descriptions, free-text "Something else…", Cancel/Submit, sidebar pending-indicator. Full round-trip verified (answered "Yes" → agent continued). |
| `clarification` | ✅ (code) | Mapped to a select card (`event-map.ts:361`). |
| `permission` | ✅ (code) | 7-choice approval card (`event-map.ts:422`, `ui-bridge.ts`). Not triggered live (parity config is `bypass_plus`). |
| `plan_handoff` | ✅ (code) | Plan-review select (`event-map.ts:391`). |
| `confirmation`, `capability` | ✅ (code) | In the vendored enum; handled. |
| **`goal_proposal`** | 🟢 | Handled — renders a `confirm` card (Accept/Reject) from `GoalProposalContext`; maps to `goal_proposal_answer{accepted}`. Default arm is deny-safe for future unknowns. |

### 5. Goals — 🟡 approval fixed, display still missing

No goal display (TODO: "polytoken shows '(goal)' next to the facet"), but the
`goal_proposal` approval path is now handled — renders an Accept/Reject card and
maps to `goal_proposal_answer{accepted}`. The `default:` arm is deny-safe so no
future unknown interrogative type can wedge the session.

### 6. Todos / jobs / subagents / flags (the TUI right sidebar)

| Feature | State | Evidence |
|---|---|---|
| Todos | 🟡 | No right-sidebar/checklist. Pilot has an "Open tasks · N" popover pill in the composer (`TaskList.svelte`, fed by parsing `todo_*` tool calls). After creating 2 todos they showed **only as (then-merged) tool cards** — no live todo panel like the TUI's Todos pane. |
| Background jobs | 🔴 | No jobs UI. TUI has a Jobs pane (`Ctrl+F3`) + `/jobs`. Pilot surfaces subagent/job activity only as inline tool cards. |
| Flagged files | 🔴 | No flags UI. `SessionStateSnapshot.flags[]` is on every `/state` but pilot never reads it. TUI has a flags pane (`Ctrl+F2`). |
| Subagents | 🟡 | Render as inline tool cards; no dedicated subagent/job drill-down (`/subagent/{handle}/history` unused). |

*(All four are the open TODO "Right-side sidebar: flagged files, todos, async jobs (polytoken TUI parity).")*

### 7. Plan mode

🟡 `PlanView.svelte` + `activePlan` on `SessionState`; `plan_handoff` approval handled. Plan
write/edit/review machinery is represented. Not exercised live this run.

### 8. Sessions & history

| Feature | State | Evidence |
|---|---|---|
| Create session (dir picker) | ✅ | Good UX: project-grouped sidebar, "New session in project", a `DirPicker` with breadcrumb + path-mode typing + **recent chips** + inline `statPath` validation + worktree toggle. |
| Session list / search / active-only | ✅ | Project-grouped sidebar, search box, "Active only" filter; multiple concurrent live sessions worked (2–3 daemons). |
| Rename / archive / unarchive | ✅ (code) | `renameSession`/`setArchived` implemented + `⋯` per-session actions menu (not clicked live this run). |
| Worktree sessions | ✅ (code) | Composer worktree toggle → `newSession({worktree})`; `cleanupWorktree` implemented. |
| Reload session (recovery) | ✅ (code) | `reloadSession` implemented (dispose+rewarm) — the intended recovery for a wedged session. |
| Title | 🟡 | `/title` slash passthrough; session title also shown in header ("main"). No dedicated rename-to-title affordance beyond sidebar rename. |
| Stale "Working…" lifecycle | 🟡 | Previously the hub could get stuck believing a session is streaming (the `goal_proposal` wedge) with no self-heal. Fixed — the deny-safe default arm lets any interrogative be dismissed to unblock the turn. |

### 9. Providers / auth / config (Settings panel)

The Settings dialog is well-structured (Appearance, Notifications, Providers, Models,
Extensions, Environment, Access token) and degrades gracefully, **but several tabs are
non-functional against the live daemon:**

| Feature | State | Evidence |
|---|---|---|
| Appearance (theme/text-size/hide-thinking) | ✅ | System/Light/Dark, A-/A+, Hide-thinking toggle. Pilot-native, good for mobile. |
| Notifications / Web Push | ✅ | Web Push shipped + verified on iPhone (DESIGN). The red "Blocked" chip in headless Chrome is just the browser's notification-permission state. |
| **Providers / API keys** | 🔴 | "No providers reported by the server" — `listProviders`/`setProviderApiKey` are mock-only. |
| **OAuth sign-in/out** | 🔴 | `oauthLogin`/`oauthLogout` mock-only; the OAuth dialog + e2e exist but aren't wired to the polytoken daemon. (Owner already flagged "partial pending real-world use.") |
| **Extensions enable/disable** | 🔴 | "No extensions loaded for this session" — `listExtensions`/`setExtensionEnabled` mock-only. (Parity config also loads none, but the methods are absent regardless.) |
| Environment (login shell, background model) | 🟢/🟡 | Login shell wired live: captured at driver construction and passed as `env` to every daemon spawn (so the daemon gets the user's real PATH). Background model still deferred (TODO in NEXT-SESSION.md B10). |
| Access token | ✅ | Present. |
| **MCP server management** | 🔴 | `/mcp` slash passthrough only; no Settings UI for enable/disable/reconnect/OAuth despite full daemon support. |
| Daemon reload / reset-shell | 🟡 | `/daemon-reload`, `/reset-shell` via slash passthrough only. |

### 10. Project trust (D12)

🔴 / ⚠️ `subscribeTrust`/`respondTrust`/`setClientPresence` are **not implemented** in the
polytoken driver, so the first-run trust card (a stated MUST) never fires with the live
daemon. No trust prompt appeared opening the project (it was `bypass_plus` + already touched
by the TUI, so I couldn't force the untrusted path). Flagging as unwired + needs a clean
untrusted-dir test.

### 11. Slash commands (cross-cutting)

🟡 The slash menu surfaces the **full** command set with descriptions, each badged BUILTIN
(`/clear /compact /daemon-reload /detach /facet /goal /help /inputdebug /jobs /mcp
/permissions /quit /refresh /reset-shell /rewind /title /version`). `/model`/`/models` are
correctly omitted (native picker). `/tree` was intercepted for the native view but
  **is now removed** (2026-07-01 — the tree view was deleted). Commands
route by sending `/name args` as a normal prompt (the daemon interprets builtins).
**Caveats:** (a) several are **TUI-only and meaningless in a web UI** yet still listed —
`/detach`, `/inputdebug`, `/refresh`, `/quit`; (b) routing ≠ rendering — e.g. `/goal`
"routes" but breaks (§5), and `/jobs`/`/todo`/`/help` have no rich pilot result view.

### 12. Tool-result rendering

✅ Clean per-tool cards (name, input, duration, status, expandable). 🟡 Over-merging into
"Worked for Ns" on completion (TODO). ANSI-stripping/diff previews exist in code.

### 13. Image attachments

🟡 Composer "Attach images" + file input + `ImageLightbox` + `image-attachments.ts` exist
(LATER-tier feature). Not exercised live.

---

## Minor / cosmetic findings

- **Spurious error on every new session:** `[polytoken] newSession: model apply failed POST
  /model failed (409): model is already '…'` — pilot applies the model on create even when it
  equals the default; should treat `no_change` (409) as success rather than logging an error
  (`polytoken-driver.ts:951`).
- **Two popovers can be open at once** (model menu + slash menu) when driven
  programmatically — minor focus-management nit.
- **Send button vs Enter:** clicking the composer "Send"/"Create session and send" submitted
  reliably; this is a non-issue for users (noted only because automated `fill`+click timing
  was occasionally racy).

## Process note (not a pilot feature, but it blocked testing)

- The `preview_start("pilot-parity")` server doesn't inherit the provider keys (they come from
  `~/.zshenv`, which the preview process doesn't source), so the daemon spawn failed with
  `$UMANS_API_KEY … is not set`. Worked around by inlining the key into the **isolated**
  config. Also: the harness only writes `config.yaml` when absent (`parity/lib.ts:241`), so a
  stale pre-`lib.ts`-fix config survived — `down --purge` was needed. Both are harness/env
  friction worth smoothing for future GUI parity runs (e.g. launch the GUI under a shell that
  sources `~/.zshenv`, or have the harness always regenerate the config).

## Suggested priority order to close gaps

1. ~~**`goal_proposal` interrogative**~~ — ✅ done. Vendored enum regenerated from the live
   0.4.x daemon; `goal_proposal` handled with a confirm card → `goal_proposal_answer`; the
   `default:` arm is now deny-safe (blocking dialog → `{kind:"cancel"}`) so no future
   unknown interrogative can wedge the session. Remaining: goal *display* (the "(goal)"
   badge next to the facet).
2. **Wire the mock-only driver methods into the polytoken driver** — ~~`getTree`~~ (removed),
   `listProviders`
   + key/OAuth, `listExtensions`, `setDefaultModel`/`setFavoriteModels`, `subscribeTrust`.
   These features look done (and pass e2e) but are dead against the real daemon.
3. **Permission-monitor control** in the bottom bar (urgent TODO).
4. **Right-side sidebar** for todos / jobs / flagged files (TUI parity).
5. **Relabel "Branch" → "Rewind"** (or implement true branching) and **stop over-merging** tool
   cards.

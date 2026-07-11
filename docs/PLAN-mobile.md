# Mobile app plan — iPhone, PWA-first

Status: **build in progress** (kicked off 2026-07-10 ~23:10 CEST). All open
questions were answered by Timo in the evening review — resolutions are folded
into the sections below and summarized under *Decisions from the evening
review*. Live build state: see *PROGRESS* at the bottom.

## ✅ Decision: the mobile app is the installed PWA. No wrapper.

The stack question resolves on a chain of verified facts (adversarially
fact-checked against 2025–2026 sources, all confirmed):

1. **A free Apple ID cannot hold the push-notification entitlement.** Personal
   teams get no `aps-environment`, period. Any native app built without the
   $99/yr Developer Program — Tauri, Capacitor, or raw Swift — **cannot receive
   push at all**, and free provisioning re-signs every 7 days (3-app cap).
   Timo has no paid account and doesn't want the hassle.
2. **A native wrapper would *subtract* capability here.** WKWebView runs no
   service workers and has no Web Push, so wrapping the existing client kills
   the already-working web-push pipeline and forces a from-scratch APNs path
   (which needs the paid account — see 1). Background WebSocket is *not* a
   differentiator: iOS suspends native apps seconds after backgrounding too;
   push-then-reconnect-on-foreground is the architecture either way.
3. **Tauri iOS is additionally a yak-shave right now**: open link-time
   breakage against Xcode 26 / iOS 26 SDK (tauri#15066), broken simulator
   targeting (tauri#14233), and mobile is by the maintainers' own framing not
   a first-class citizen. Not an overnight project even if we wanted it.
4. **Web push from an installed home-screen PWA works on iOS without any Apple
   account** — Apple relays it through their push infrastructure using exactly
   the VAPID pipeline pantoken already ships (`client/src/lib/push.ts`,
   `server-rs/pantoken-server/src/push.rs`). It demonstrably worked on this
   very phone in the Pilot/pi era.
5. **iOS 26 removed the install friction**: every Safari Add-to-Home-Screen now
   opens as a web app by default (no installability criteria). Installed
   home-screen apps are **exempt from the 7-day ITP storage eviction**, so the
   bearer token in localStorage persists indefinitely. Confirmed unaffected by
   EU/DMA changes (Apple reversed the 17.4 PWA removal before it shipped).

**What we accept (hard iOS platform ceilings, no stack changes them for us):**

- **No Approve/Deny buttons on the lock screen.** iOS web push ignores
  `Notification.actions` through 26.5. Mitigation: notification deep-links
  straight to the approval in the right session — flow is *tap notification →
  app opens on the approval card → one tap*. (Native `actions` would need paid
  APNs anyway.)
- **No haptics.** Safari never implemented `navigator.vibrate`; the checkbox
  Taptic hack was patched out in 26.5. Drop the TODO's haptics item for iOS.
- **Default notification sound only**; no custom alert tones.

**Revisit trigger:** if a paid Apple Developer account ever materializes, the
wrapper of choice is **Capacitor 8** (first-class push/badge/haptics plugins,
minimal Xcode contact), *not* Tauri iOS — a thin client shares no sidecar or
Rust with the desktop shell, so there's no synergy argument. Until then: PWA.

## ✅ Distribution & updates (already solved, reuse as-is)

- **Install:** Safari → `https://<mini>.<tailnet>.ts.net/?token=…` → share →
  Add to Home Screen (per `deploy/DEPLOY.md`). Token is saved to localStorage
  and scrubbed from the URL. One-time, no store, no signing, no account.
- **Updates:** push to `main` → Mini blue-green deploy within ~60s → service
  worker update detection (`client/src/lib/sw.ts`, `skipWaiting` already
  wired) picks it up on next open. The deploy pipeline **is** the app-update
  mechanism.
- ⚠️ **Consequence for the overnight build:** `main` deploys straight to the
  phone's origin. Overnight work happens on a **separate jj bookmark**; merge
  to `main` only at phase gates where the full check suite is green.

## What already exists (inventory — do not rebuild)

| Piece | Where | State |
|---|---|---|
| Phone breakpoint (≤859px) | `App.svelte`, `Sidebar`, `RightSidebar`, `Composer`, `Transcript` | working |
| Left sidebar as drawer + scrim | `Sidebar.svelte` | working; polish only |
| Edge-swipe to open drawer | `lib/edge-swipe.ts` | working |
| Right panel as right-edge drawer | `RightSidebar.svelte` | working but wrong UX for phone — being replaced (this plan) |
| Keyboard insets (visualViewport) | `lib/keyboard-inset.ts` | working |
| Pull-to-refresh | `lib/pull-to-refresh.ts` | working |
| Wake lock while streaming | `lib/wake-lock.ts` | working |
| Web push end-to-end (VAPID, subscribe, send) | `lib/push.ts` + `server-rs/…/push.rs` | ported to Rust server — **needs real-device revalidation** |
| Notification deep-links | `public/sw.js` `notificationclick` → `url` from `PushNotification.url` | plumbing exists |
| SW update flow | `lib/sw.ts` + `public/sw.js` | working |
| PWA manifest + icons (incl. maskable) | `client/public/manifest.webmanifest` | good; name says "pi" in description |
| Tailscale + token + TLS + blue-green deploy | `deploy/` | working |
| e2e mobile project (Pixel 7, Chromium) | `playwright.config.ts` | working; extend with new specs |

The mobile app is therefore **not a new app**: it's a form-factor redesign of
the phone experience of the existing client, plus push hardening, plus polish.

## Design spec — phone form factor

### D1. Left sidebar (sessions): keep the drawer ✅ (as requested)
Manually opened (hamburger / edge-swipe), never persistent. Tonight is a
polish pass only: ≥44px hit targets, safe-area-inset padding, scrim tap +
swipe-to-close, no layout shift.

### D2. Right sidebar → badged header entry + full-screen Context views
Replaces the current right-edge drawer on phone (desktop keeps the sidebar).

Research across Claude iOS, ChatGPT, GitHub Mobile, Linear converged clearly:

- **Entry point:** ONE icon button in the header's top-right (panel glyph),
  with an **attention badge** (count bubble) and a subtle "job running"
  indicator. *Not* a bottom tab bar (these are session-scoped panels, not app
  sections; the bottom belongs to the composer/keyboard). *Not* an overflow
  menu (hides the badge). *Not* three separate header icons (no room at 375px
  next to bell + settings + status dot; fallback option if one-tap-per-panel
  proves necessary).
- **View type:** tapping it opens a **full-screen Context screen** (GitHub
  Mobile "Files changed" pattern), not a bottom sheet — sheets are for
  transient pickers, not browsable multi-step content.
- **Layout inside (✅ decided — OQ2):** three stacked sections with counts —
  Flagged files / Background jobs / Todos, same order as the TUI — reusing the
  section markup + `JobDetail`/`TodoDetail` that `RightSidebar.svelte` already
  renders. Sections collapse to count rows when long.
- **Back navigation:** pushed as a history entry so **iOS swipe-back and the
  browser back button close the view** instead of leaving the app. Same
  history integration for the left drawer (open drawer = history entry) —
  standalone PWAs have no browser chrome, so back-gesture correctness is the
  difference between "app" and "webpage" feel.

### D3. Badge semantics (✅ decided — OQ3, simplified per Timo)
The badge is a **plain total: flagged files + background jobs + todos** — the
same numbers the panel sections show. No unseen/unread tracking, no
"changed while you weren't looking" state. Show the bubble when the total is
> 0, hide otherwise. Approvals stay **out** of the Context badge.

### D4. Approvals on phone
Inline transcript card (exists) is already the shipped pattern in Claude/ChatGPT
mobile. Per Timo: approvals may take (near-)full screen on phone; **minimizable
like the desktop app is a nice-to-have, not a showstopper** — audit
`ApprovalLayer.svelte` at 375px and keep/port the minimize affordance only if
it falls out cleanly. Work tonight: make the **push deep-link land on the
approval** — `PushNotification.url` already routes via `sw.js`; sharpen it to
session + scroll-to-approval, and verify the tap→approve flow is two taps max.

### D5. Composer & header ergonomics
- **Bug (seen in preview at 375px):** the picker row overflows — the model chip
  clips off-screen. Compact the chips on phone (icon + short label, or a
  single "session setup" chip opening a sheet with the three pickers).
- Header at 375px: drawer toggle · title (truncates, exists) · bell · settings
  · status dot · context entry. Audit spacing/hit areas.
- Keyboard: `keyboard-inset.ts` exists; verify composer stays above the
  keyboard with the new views open, and that Context screen scroll position
  survives keyboard show/hide.

### D6. iOS standalone polish
- `theme-color` currently light-only (`#f7f6f2`) — add media-scoped
  `<meta name="theme-color" media="(prefers-color-scheme: dark)">` so the
  status bar matches dark mode.
- Safe-area audit: `env(safe-area-inset-*)` on header, drawers, composer,
  Context screen (home-indicator gap), plus `viewport-fit=cover`.
- `overscroll-behavior` containment so drawer/panel scrolling never
  rubber-bands the app shell; `-webkit-text-size-adjust: 100%`.
- Manifest description still says "pi coding agent" — update.

### D7. Touch conventions (amends the repo convention, not replaces it)
"Every UI action needs a hotkey and a tooltip" is a desktop convention;
`title` attrs are inert on touch and hotkeys don't exist there. On phone the
equivalent rule for tonight's new UI: **every action is a visible, labeled
(aria-label + ≥44px) control** — no hover-revealed or hotkey-only affordances
on touch paths. Add this as a note to AGENTS.md conventions.

### D8. Push hardening
- Re-validate the Rust server's web push from the real phone (worked in the
  Pilot/Bun era; `push.rs` is the port — morning checklist item M3).
- On push receive: `setAppBadge(count)` (Badging API, iOS 16.4+); clear on
  focus. Covers the TODO's "app-icon unread badge" for free.
- **Declarative Web Push: skipped for v1** (was OQ6). Timo's constraint —
  "only do autonomous stuff you can verify yourself" — rules it out: it is an
  iOS-Safari-only format that cannot be exercised in Chromium/Playwright or
  the mock driver, so an overnight adoption would ship unverified. Classic SW
  push stays (it's the on-device-proven path). Filed in TODO.md as a
  candidate with a real-device test plan.
- Distinct notification `tag`s per kind (approval / turn-complete / job-done)
  so later notifications coalesce sensibly.

## ✅ Deferred (explicitly out of v1)

- **Typed-in tailscale hostnames / multi-hub picker.** v1 stays same-origin:
  the PWA is served *by* the hub it controls, so there is zero server-discovery
  UI, and SW + push subscriptions are origin-bound anyway. "One installed icon
  per hub" is the correct v1 model (in practice: one — the Mini). The later
  design (shared with desktop): hub-list screen, per-hub token, cross-origin
  WS + `Origin` allowlist on the server, per-hub push subscriptions. Worth its
  own small ADR when it happens; not tonight.
- **Native wrapper (Capacitor 8)** — trigger: paid Apple account appears AND a
  ceiling above actually hurts (lock-screen actions, haptics, custom sounds).
- **Haptics on iOS** — platform ceiling; remove from Mobile/PWA TODO or mark
  Android-only.
- **Actionable notifications (Approve/Deny on the notification)** — platform
  ceiling on iOS web push; keep in TODO as Android/desktop-only note.
- **Voice dictation** — per Timo: not planned (iOS keyboard mic works today).

## Overnight execution plan

Work on bookmark `mobile-v1`, merge to `main` at gates (G✓ = full suite green:
`bun run check` + `cargo` gates via `bun run check:rs` + `bun run test:e2e`).
Each phase lands as its own jj commit(s); e2e specs land *with* their phase.

**Phase 1 — navigation skeleton (biggest risk first).**
Context entry button + badge stub in `StatusHeader.svelte`; full-screen
Context screen (new component, reusing `RightSidebar`'s sections /
`JobDetail` / `TodoDetail`); history integration for Context screen + left
drawer (swipe-back closes, never exits); desktop ≥860px completely unchanged
(`RightSidebar` stays). Mobile e2e specs: open/close via button, back-button
close, badge renders, desktop unaffected. **Gate G1 → merge.**

**Phase 2 — composer + header ergonomics.**
Picker-row compaction at ≤859px; hit-target/safe-area audit of header,
drawers, composer; keyboard-interaction checks. e2e: no horizontal overflow at
375px (assert `scrollWidth <= clientWidth`), pickers usable. **Gate G2 → merge.**

**Phase 3 — push, badge, deep-links.**
`setAppBadge`/clear wiring; notification tags; deep-link → approval anchor;
mock-driver e2e where possible (badge state via `/debug/state`, SW logic unit
tests); Declarative Web Push spike (timeboxed — adopt or file TODO).
**Gate G3 → merge.**

**Phase 4 — standalone polish + docs.**
theme-color dark meta, viewport-fit/safe-areas, overscroll, manifest text;
AGENTS.md touch-convention note; TODO.md cleanup (haptics/actions per above);
update DESIGN.md phone paragraph. Full-suite re-run incl.
`bun run test:e2e:live`. **Gate G4 → merge.**

**Stretch (only if all gates green early):** transcript performance pass on
phone-sized viewports (long sessions); "new since you left" divider (TODO)
since it pairs naturally with notification deep-links.

**Session budget vs usage limits** (exact times TBD from Timo at kickoff;
limits expected ~+6h and ~+11.5h): Phase 1 must land inside session 1 —
it's the highest-risk chunk and everything else is independent of it.
Phases 2–3 in session 2, phase 4 + stretch in session 3. At each wakeup:
`jj log` + `PROGRESS` note in the plan-file first, then continue. Set
ScheduleWakeup/cron per the times given at kickoff.

**Morning checklist (needs the physical phone — Timo, ~5 min):**
- M1 Re-install PWA from the Mini origin (delete old icon first if present).
- M2 Token flow: fresh install → `?token=` → survives relaunch.
- M3 Push: trigger approval from a test session → notification arrives on
  locked phone → tap → lands on approval card → approve works. (First
  end-to-end proof of `push.rs` on-device.)
- M4 App badge appears on job-finish, clears on open.
- M5 Swipe-back closes Context screen / drawer; app never exits to Safari.
- M6 Dark mode: status bar + theme correct in both modes.
- M7 LTE (Wi-Fi off): connect, stream a turn, background 5 min, foreground →
  reconnect + tail replay correct.

## ✅ Decisions from the evening review (2026-07-10, all OQs resolved)

- **OQ1 — Entry affordance:** one badged icon in the header. Settled.
- **OQ2 — Context screen layout:** stacked sections with counts (the
  recommendation). One full-screen Context view, three sections.
- **OQ3 — Badge semantics:** plain totals (flags + jobs + todos), no
  unseen/unread tracking. Approvals stay out of the badge; approvals may be
  (near-)full-screen on phone, desktop-style minimize is a nice-to-have only.
- **OQ4 — Breakpoint:** pure width dependence stays; a narrow desktop window
  gets the phone treatment. (Also makes testing simpler.)
- **OQ5 — WebKit e2e tier:** delegated to my judgment → add an **opt-in**
  `iphone-webkit` Playwright project (env-gated, not in the default run, not
  in CI). Rationale: the history/swipe-back work is exactly where WebKit
  diverges from Chromium, so having the proxy is worth it; the default gate
  stays Chromium-fast. Timeboxed — if the WebKit install/run misbehaves, drop
  it and note here.
- **OQ6 — Declarative Web Push:** **skipped** — Timo's constraint "only do
  autonomous stuff you can verify yourself" rules it out (iOS-Safari-only;
  not exercisable in Playwright/Chromium or the mock driver). Classic SW push
  stays; TODO entry with a real-device test plan instead.
- **OQ7 — Rename:** no rename; staying "Pantoken".
- **OQ8 — main-deploy:** not a concern per Timo (deploys will move to tagged
  GitHub releases anyway). Gates still merge only when green; **no remote
  push overnight** regardless (repo rule: never push without asking).

## PROGRESS (live, newest first)

- 2026-07-11 02:30 — **Gate G1 green → Phase 1 committed.** Clean full e2e:
  390 passed; the only real failures were a pre-existing tooltip regression
  from the evening commit `ozor` ("Fix sidebar e2e startup and resizing"
  accidentally flipped Tooltip's hover path to `begin(el, false)`, killing the
  strip/restore contract) — fixed in its own commit, tooltip specs green —
  plus one known-flaky sidebar-drafts spec (passed on retry, untouched area).
- 2026-07-11 02:15 — **Phase 1 implemented + visually verified**, full e2e
  rerun in flight. What landed: `lib/overlay-history.ts` (+8 unit tests) —
  overlay ↔ browser-history coupling so back gesture closes overlays;
  store: sidebar open/close routed through it, phone never restores/persists
  drawer state; RightSidebar = full-screen Context view on phone (z-75 above
  the header, back arrow + title, safe-areas, reduced-motion); StatusHeader =
  panel glyph + plain-total badge on phone (desktop chevron unchanged);
  new `context-screen.mobile.e2e.ts` (6 specs); updated `sidebar-resize`/
  `right-sidebar` specs to the new contract. Verified in preview at 375px and
  desktop: badge=9 with the context fixture, full-screen view renders, browser
  back closes it, desktop docked panel identical to before. First e2e run:
  386 passed, 3 fails — all understood (badge count fixed 8→9, hidden-title
  assertion updated, subpixel rounding) — plus HMR-interference flakes from
  live-editing during the run; clean rerun started with no concurrent edits.
- 2026-07-11 01:40 — Wakeup 1. Session 1 was cut short by the usage limit
  right after the plan-doc edits; no implementation had started. Now: commit
  this doc, env prep (bun install / cargo build / baseline e2e), then Phase 1.
- 2026-07-10 23:10 — Kickoff. Wakeup crons set (01:38, 06:48 local). Evening
  answers folded into the doc as decisions.

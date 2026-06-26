# Pilot — Open questions for you (morning of 2026-06-17)

Ordered by leverage. Each has my recommended default (what I built toward or will
build toward). Veto any and I'll adjust — most are cheap to change because the
frontend, protocol, and verification harness are all backend-agnostic.

> **All resolved 2026-06-17** — see `DECISIONS.md` D7–D14 for the settled calls.
> Quick map: OQ1 TS-embed ✅ · OQ2 **multiple concurrent sessions** (default
> reversed) · OQ3 **no tool gating** · OQ4 sandbox deferred, isolation via
> containerization (gondolin/pi-gondolin) · OQ5 **build Web Push now** · OQ6
> **arbitrary GUI paths, no allowlist** (trust prompt as safety net) · OQ7 **pi
> session files authoritative** (discover + resume, inverts D5) · OQ8 same-family,
> dark-first. Two pi-behavior corrections recorded in DECISIONS: the trust prompt
> is interactive-only (must be wired) and gates `.pi` config/extensions, not
> `AGENTS.md`.

## OQ1 — Backend language: TS-embed (built) vs Rust-spawn-RPC ⚠️ confirm
The handoff leaned Rust (KellerComm reuse). I went **TS-embed** (see D2) and have
now built it out: the WS server, the multi-client hub, AND the real pi driver
(event mapping + ExtensionUIContext bridge), all typechecked against the SDK with
the SDK-under-Bun risk retired. **If you still want Rust**, the cost has grown —
you'd lose the server + the driver (~the bulk of `server/`), though the Svelte
client, protocol, mock, and Playwright harness all still carry over. My honest
take remains: TS is the better fit because you want extensions visible (needs
in-process tool access) and fast dogfooding. I proceeded because you said "keep
going on obvious steps" — but flag it if you'd have chosen differently.

<review>
    yeah, this is fine for me, the arguments are convincing.
    sidenote: we don't need to follow kellercomm religiously, it was very much vibecoded and hasn't been used in production yet! (the home office move it was built for hasn't happened yet). doesn't mean we can't learn from it, but it's not a north star or anything
</review>

## OQ2 — Concurrency: one in-process session, or process-per-session?
**Default: start single in-process `AgentSession`; design the WS schema (done) to
mirror RPC events so heavy/untrusted sessions can move to a `pi --mode rpc`
subprocess later without redesign.** You're one user; true parallel multi-session
streaming is unlikely day-one. Process-per-session buys crash isolation + resource
limits when you hit the wall.

<review>
    hmm i'm not sure if this means being _limited_ to a single agent session at once? if so, i disagree with the default. i definitely want more than one agent session happening at the same time
    crash isolation / resource limits is good in principle but pi keeps the log files up to date reliably and the pilot ui should be 100% based on the persisted stuff (i want full session restoration on reload, so we need to persist anything important that's not already part of pi session files ourself!), so a crash is just a nuisance and should not lose any work that's more than ~1s old
</review>

## OQ3 — Approval posture: how hard do we gate tools?
**Default: ship pilot's own approval extension that gates bash + destructive ops
via confirm/select, on by default.** pi has **no native tool-approval gate** — out
of the box it auto-runs everything including bash. Remote = bigger blast radius;
the phone tap is your last line of defense. Decide granularity: per-tool /
per-command-pattern / remember-this-choice.

<review>
    disagree, like i just told you in the interactive session. nothing more to say about this i think?
</review>


## OQ4 — Sandbox by default, and how complete?
**Default: host-side `@anthropic-ai/sandbox-runtime` extended to route
read/write/edit (not just bash — the shipped example only wraps bash, so as-is
it's a false sense of safety), with a strict `sandbox.json`; Gondolin micro-VM as
an opt-in per-session "high isolation" toggle.** Need to confirm macOS
`sandbox-exec` network allowlisting actually holds on your macOS version before
relying on it for egress.

<review>
    i think i'm fine with deferring this for now? i already trust fully skip-permission mode claude and pi+deepseek sessions so this isn't a security degradation. fwiw, the fully autonomous and async work happens on a user account on the mac mini that has limited permissions. pilot running on my local machine is also gonna use very capable models and be supervised a bit more closely, so i'm fine deferring this.
</review>


## OQ5 — Notification reach: tab-open only, or backgrounded phone?
**Default: Notification API (tab-open) in MVP; defer Web Push to LATER.** Web Push
for a closed phone is greenfield (service-worker handler + VAPID + subscription
store) and iOS Web Push only works for an *installed* PWA and is historically
flaky. This is the biggest-payoff feature with zero scaffolding — worth validating
on your actual iPhone iOS version before committing.

<review>
    yeah i wanna build this. if we don't get it working, not a huge deal, but i would like to have it :)
</review>


## OQ6 — Workspace provisioning: how do phone-triggered sessions pick a directory?
**Default: a fixed allowlist of repo paths on the Mac Mini the UI may open; no
arbitrary-path opening from the phone.** The desktop app used a native folder
picker the browser can't; arbitrary remote `cwd` also widens the attack surface.

<review>
    i think arbitrary path opening is actually fine as long as it's human - gui controlled. if an existing agent session cd's into another path to read a cloned repo or something, it won't autoload the AGENTS.md and therefore the risk is limited. if i want to start a new project on the mac mini i don't want to configure the allowlist config file, i want to just open the path imo.
    if i missed an attack vector here, let me know! so far this just seems like extra busywork to protect myself from a fat finger (also, pi's built in approval popup the first time it starts in an unknown cwd is gonna be shown, right? that's a thing i want, with a convenient way to look at the file contents being a nice-to-have but i can also do that using other tools if it doesn't fall out of our design anyway, i think we don't really need to build a project file explorer lol... unless? :eyes:)
</review>


## OQ7 — Transcript persistence across a *server* restart mid-turn?
**Default: in-memory authoritative transcript for active sessions, backed by pi's
on-disk `.jsonl` for idle/restart recovery; no separate durable store at MVP.**
Surviving a server crash *mid-turn* needs server-side persistence — extra scope.

<review>
    yeah i don't know about this one! i think we should try to run a remote pi session as closely as possible to as if i ran cli `pi` on that server via ssh, e.g. discover existing pi sessions on that server etc (and leave an up-to-date session file for new sessions on the server, too). if this is hard, let's discuss it.
</review>


## OQ8 — Styling fidelity: how close to the Claude app, and dark/light?
**Default: Claude-app-like (warm neutrals, generous spacing, the streaming/tool
card vocabulary), dark-first with a light theme, no permission UI except the
first-run trust card.** Tell me if you want pixel-faithful vs just "same family."

<review>
    oh, same family to start with, as soon as i dogfood i can imagine proposing changes from the way claude does it, too. things i like are how prose reads, e.g. font rendering should be beautiful, tool calls should be inspectable but unobtrusive. i like having quick ways to navigate a session, so having like a hotkey to jump to my last prompt would be neat, or maybe we could consider a minimap on the right side at some point lol (not sure about that one!)
    i think that's the area we could go ham with just to have something to continuously improve when the meat and bones are good.
</review>

## OQ9 — iOS keyboard accessory bar (prev/next/done): live with it, or rewrite the composer to contenteditable? — TABLED

**Status: tabled 2026-06-26. Needs a fresh discussion before deciding — recorded
here so the trade-off isn't rediscovered from scratch.**

On iOS, focusing any `<textarea>`/`<input>` makes WKWebView draw a native
**form-navigation accessory bar** above the keyboard (`UIWebFormAccessory`): a
▲/▼ pair that cycles between focusable form fields on the page, and a ✓ "Done"
that dismisses the keyboard. It's platform chrome — nothing in pilot renders it
(verified: the Composer's only top-border element is the single expand caret
`⌃`/`⌄`, which doesn't match). It fires on all three text-input surfaces:
`client/src/components/Composer.svelte`, `QnaForm.svelte`, `ApprovalLayer.svelte`.

The user finds it unwanted dead weight (single-field UI → prev/next do nothing
useful) and wants it gone. The honest problem: **no web API removes it for a
standalone PWA.** Checked — `enterkeyhint` only relabels Return, `inputmode` only
swaps keyboard layout, the `VirtualKeyboard` API is Chromium-only and ignores
the accessory, and the viewport/`interactive-widget` meta is about resize, not
the bar. The native knobs that *do* hide it (Cordova
`HideKeyboardFormAccessoryBar`, Tauri/wry input-accessory-view removal) operate
on a *wrapped* WKWebView — which would mean abandoning the pure-PWA
architecture settled in D3. Not on the table.

The one real web lever is **swapping the `<textarea>` for a `contenteditable`
div**: iOS doesn't show the form-assistant bar for a contenteditable element
(it's not a "form field," so there's nothing to prev/next between). This is the
commonly-cited workaround. **Caveat flagged, not buried:** I couldn't find a hard
2025/26 confirmation that it suppresses the bar in a standalone home-screen PWA
on current iOS — it's well-supported anecdotally but not a documented guarantee.

The cost is real, not a drop-in. The Composer is deeply textarea-shaped:
`ta.selectionStart`/`ta.selectionEnd` drive `@`-mention insertion
(`file-autocomplete.ts`), slash-query detection (`slash.ts`), and readline
history (`caret-visual-line.ts`, `prompt-history.ts`) — a contenteditable
element has neither, so caret offset gets re-derived from `Selection`/Range
APIs. Autosize (`scrollHeight`→`height`) differs, paste needs sanitization
(rich paste → plain), IME composition and caret-position math are
browser-inconsistent, and "the text" stops being a single plain string the store
owns and becomes a derived thing. Meaningful rewrite of the Composer's input
core (caret tracking, mentions, slash, history, autosize, paste) with a real
regression surface — **for a fix that isn't guaranteed to work** until tried on
the device.

Two honest paths when this gets revisited:

1. **Verify the lever before paying for it.** Stand up a throwaway page (one
   `contenteditable` div + one `<textarea>`) as a PWA on the actual iPhone. If
   the bar is gone on the contenteditable one and present on the textarea, the
   rewrite is justified; if it's still there, stop — accept/document instead.
   ~15 min, kills the key uncertainty before any rewrite.
2. **If verified → rewrite** the three textareas to contenteditable (behind the
   existing `isTouch` guard where reasonable), extending the e2e suite to cover
   caret/mention/history on the new element.

If not verified, **accept it**: the ✓ Done is arguably useful anyway; it's the
prev/next that are dead weight with a single field. Document as a known iOS
platform limitation in `DECISIONS.md`, zero code.

What this entry deliberately does *not* do: commit to the contenteditable
rewrite on an unverified assumption. The trade-off is "large rewrite, real
regression risk" vs. "one strip of iOS chrome that's mostly harmless," and the
deciding fact (does contenteditable even suppress it on current iOS PWAs?) is
cheap to check first.

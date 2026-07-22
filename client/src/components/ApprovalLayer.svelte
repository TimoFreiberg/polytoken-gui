<script lang="ts">
  import { onDestroy } from "svelte";
  import { reveal } from "../lib/transitions.js";
  import { isDialogRequest, type HostUiRequest } from "@pantoken/protocol";
  import { store } from "../lib/store.svelte.js";
  import { attention } from "../lib/attention-cycle.svelte.js";
  import Button from "./ui/Button.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import Markdown from "./Markdown.svelte";

  // Show one dialog at a time — the oldest pending. `qna` is rendered inline in the
  // chat column by QnaInline, not as a floating sheet, so skip it here (the two can
  // coexist on desktop: a floating confirm over the inline form).
  const pending = $derived(store.session.pendingApprovals);
  const mobileCurrent = $derived(
    pending.find((r) => r.requestId === attention.mobileRequestId) ?? pending[0] ?? null,
  );
  const current = $derived(
    store.phoneLayout
      ? mobileCurrent?.kind !== "qna" ? mobileCurrent : null
      : pending.find((r) => r.kind !== "qna") ?? null,
  );
  const mobileIndex = $derived(
    current ? pending.findIndex((r) => r.requestId === current.requestId) : -1,
  );

  let inputValue = $state("");
  let selectedOption = $state<string | null>(null);
  type ApprovalDraft = { inputValue: string; selectedOption: string | null };
  const APPROVAL_DRAFTS_KEY = "pantoken.approvalDrafts";
  function loadApprovalDrafts(): Map<string, ApprovalDraft> {
    if (typeof localStorage === "undefined") return new Map();
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(APPROVAL_DRAFTS_KEY) ?? "[]");
      if (!Array.isArray(parsed)) return new Map();
      return new Map(
        parsed.filter(
          (entry): entry is [string, ApprovalDraft] =>
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            typeof entry[1]?.inputValue === "string" &&
            (entry[1]?.selectedOption === null ||
              typeof entry[1]?.selectedOption === "string"),
        ),
      );
    } catch {
      return new Map();
    }
  }
  const approvalDrafts = loadApprovalDrafts();
  function persistApprovalDrafts(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        APPROVAL_DRAFTS_KEY,
        JSON.stringify([...approvalDrafts.entries()]),
      );
    } catch {
      // Best effort: private mode/quota failures must not break an approval flow.
    }
  }
  const approvalDeadlines = new Map<string, number>();
  function draftKey(requestId: string): string {
    return `${store.session.ref?.sessionId ?? "unknown"}:${requestId}`;
  }
  function rememberDraft(): void {
    if (!current) return;
    approvalDrafts.set(draftKey(current.requestId), {
      inputValue,
      selectedOption,
    });
    if (approvalDrafts.size > 20) {
      const oldest = approvalDrafts.keys().next().value;
      if (oldest) approvalDrafts.delete(oldest);
    }
    persistApprovalDrafts();
  }

  // Prune drafts for resolved requests whenever their owning session is active.
  $effect(() => {
    const sessionId = store.session.ref?.sessionId;
    if (!sessionId) return;
    const prefix = `${sessionId}:`;
    const live = new Set(pending.map((request) => draftKey(request.requestId)));
    let changed = false;
    for (const key of approvalDrafts.keys()) {
      if (key.startsWith(prefix) && !live.has(key)) {
        approvalDrafts.delete(key);
        changed = true;
      }
    }
    if (changed) persistApprovalDrafts();
  });

  // Restore per-request state when navigating; initialize untouched requests from
  // their daemon-provided defaults.
  $effect(() => {
    const c = current;
    const saved = c ? approvalDrafts.get(draftKey(c.requestId)) : undefined;
    if (c && (c.kind === "input" || c.kind === "editor")) {
      inputValue = saved?.inputValue ?? c.initialValue ?? "";
    } else {
      inputValue = "";
    }
    selectedOption = saved?.selectedOption ?? null;
  });

  function cancel() {
    if (!current) return;
    approvalDrafts.delete(draftKey(current.requestId));
    persistApprovalDrafts();
    approvalDeadlines.delete(draftKey(current.requestId));
    attention.clear("approval");
    store.respondUi({ requestId: current.requestId, cancelled: true });
  }
  // An input/editor with unsaved edits — a stray backdrop tap shouldn't nuke typed text.
  const isDirty = $derived.by(() => {
    const c = current;
    if (!c || (c.kind !== "input" && c.kind !== "editor")) return false;
    return inputValue !== (c.initialValue ?? "");
  });
  // These dialogs are cheap to reopen, so a backdrop tap dismisses — EXCEPT a dirty
  // input/editor, where a stray tap (common on a phone) would lose what you typed; there
  // the buttons are the deliberate dismissal.
  function scrimClick() {
    if (isDirty) return;
    cancel();
  }
  // Desktop's attention cycle leaves a dirty input/editor open instead of pill-minimizing
  // it. Phone minimization is safe because the per-request draft map restores its text.
  const minimized = $derived(
    store.phoneLayout
      ? attention.mobileMinimized
      : attention.minimized.approval && !isDirty,
  );

  function minimize(): void {
    if (store.phoneLayout) attention.minimizeMobile();
    else attention.minimize("approval");
  }

  function moveMobile(delta: number): void {
    if (pending.length < 2 || mobileIndex < 0) return;
    rememberDraft();
    const next = pending[(mobileIndex + delta + pending.length) % pending.length];
    if (next) attention.selectMobile(next.requestId);
  }
  function confirm(value: boolean) {
    if (!current) return;
    approvalDrafts.delete(draftKey(current.requestId));
    persistApprovalDrafts();
    approvalDeadlines.delete(draftKey(current.requestId));
    attention.clear("approval");
    store.respondUi({ requestId: current.requestId, confirmed: value });
  }
  function submitValue(v: string) {
    if (!current) return;
    approvalDrafts.delete(draftKey(current.requestId));
    persistApprovalDrafts();
    approvalDeadlines.delete(draftKey(current.requestId));
    attention.clear("approval");
    store.respondUi({ requestId: current.requestId, value: v });
  }

  // Click-twice confirm gate for the plan-kind Cancel button (mirrors
  // ContextMeter.svelte). First click arms (label → "Click again",
  // danger-red); second click fires submitValue(cancelLabel). A 3s timer
  // auto-disarms. Only the plan kind's Cancel is gated — other approval kinds
  // stay single-click per the issue.
  const ARM_TIMEOUT = 3000;
  let planCancelArmed = $state(false);
  let planCancelTimer: ReturnType<typeof setTimeout> | null = null;
  function disarmPlanCancel(): void {
    planCancelArmed = false;
    if (planCancelTimer) {
      clearTimeout(planCancelTimer);
      planCancelTimer = null;
    }
  }
  function attemptPlanCancel(): void {
    if (!current || current.kind !== "plan") return;
    if (planCancelArmed) {
      disarmPlanCancel();
      submitValue(current.actionLabels[2]);
    } else {
      planCancelArmed = true;
      planCancelTimer = setTimeout(disarmPlanCancel, ARM_TIMEOUT);
    }
  }
  onDestroy(() => disarmPlanCancel());
  const planCancelLabel = $derived(
    planCancelArmed
      ? "Click again"
      : current?.kind === "plan"
        ? current.actionLabels[2]
        : "",
  );

  // --- Binary 2-option select → Yes/No card ---
  // Classify an option label as affirmative / negative / neutral so we can
  // mirror the confirm dialog's ordering (negative ghost on the left,
  // affirmative accent on the right) instead of trusting the array order.
  const AFFIRMATIVE = /\b(yes|ok(ay)?|allow|confirm|continue|trust|enable|accept|approve|proceed)\b/i;
  const NEGATIVE = /\b(no|cancel|deny|don'?t|stop|disable|reject|decline|abort|never)\b/i;
  function optionPolarity(label: string): "affirmative" | "negative" | "neutral" {
    const aff = AFFIRMATIVE.test(label);
    const neg = NEGATIVE.test(label);
    // "don't allow" contains both — negative wins (it's a refusal phrasing).
    if (neg) return "negative";
    if (aff) return "affirmative";
    return "neutral";
  }

  // Resolve the two options into { affirmative (primary, right), negative
  // (ghost, left) }. If neither reads as affirmative, keep the given order:
  // options[0] → primary (right), options[1] → ghost (left), matching the
  // previous behaviour so non-yes/no binaries don't get reshuffled.
  const binarySelect = $derived.by(() => {
    if (current?.kind !== "select" || current.options.length !== 2) return null;
    const [a, b] = current.options as [string, string];
    const pa = optionPolarity(a);
    const pb = optionPolarity(b);
    // Prefer the clearly-affirmative option as primary, the other as ghost.
    if (pa === "affirmative" && pb !== "affirmative") return { affirmative: a, negative: b };
    if (pb === "affirmative" && pa !== "affirmative") return { affirmative: b, negative: a };
    // No clear affirmative (both/neither) → preserve original order.
    return { affirmative: a, negative: b };
  });

  // --- Countdown for timeout-bearing dialogs ---
  // confirm/input/select may carry timeoutMs (editor never does). The request
  // has no start timestamp, so we start the clock on first render and tick it
  // down; at zero we fire the deny-safe default for the kind.
  const timeoutMs = $derived(
    current && "timeoutMs" in current && typeof current.timeoutMs === "number"
      ? current.timeoutMs
      : null,
  );
  let remainingMs = $state(0);
  const remainingSec = $derived(Math.max(0, Math.ceil(remainingMs / 1000)));
  const progress = $derived(timeoutMs ? Math.max(0, Math.min(1, remainingMs / timeoutMs)) : 0);

  // Deny-safe auto-resolution: confirm → confirm(false); plan → the cancel label
  // (a typed plan_handoff_answer, matching the visible Cancel button's wire shape —
  // not the universal {cancelled} that other kinds use); everything else → cancel().
  function autoResolve(c: HostUiRequest): void {
    const key = draftKey(c.requestId);
    approvalDrafts.delete(key);
    persistApprovalDrafts();
    approvalDeadlines.delete(key);
    attention.clear("approval");
    if (c.kind === "confirm")
      store.respondUi({ requestId: c.requestId, confirmed: false });
    else if (c.kind === "plan")
      store.respondUi({ requestId: c.requestId, value: c.actionLabels[2] });
    else store.respondUi({ requestId: c.requestId, cancelled: true });
  }

  // Phone deadlines belong to requests, not the visible card, so navigating cannot
  // suspend denial. Desktop retains its established current-card-only clock.
  $effect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const liveKeys = new Set<string>();
    const scheduled = store.phoneLayout ? pending : current ? [current] : [];
    for (const request of scheduled) {
      if (
        request.kind === "qna" ||
        !("timeoutMs" in request) ||
        typeof request.timeoutMs !== "number"
      )
        continue;
      const key = draftKey(request.requestId);
      liveKeys.add(key);
      const deadline =
        approvalDeadlines.get(key) ?? Date.now() + request.timeoutMs;
      approvalDeadlines.set(key, deadline);
      timers.push(
        setTimeout(() => autoResolve(request), Math.max(0, deadline - Date.now())),
      );
    }
    for (const key of approvalDeadlines.keys())
      if (!liveKeys.has(key)) approvalDeadlines.delete(key);
    return () => timers.forEach(clearTimeout);
  });

  // Keyed on requestId so the timer restarts for each new dialog and is torn
  // down on change/unmount. We tick every 250ms (smoother bar than 1s) and
  // stop at zero; the per-request scheduler above owns auto-resolution.
  $effect(() => {
    // track these so the effect re-runs when the active dialog changes
    const id = current?.requestId;
    const total = timeoutMs;
    if (!id || total === null) {
      remainingMs = 0;
      return;
    }
    const key = draftKey(id);
    const deadline = approvalDeadlines.get(key) ?? Date.now() + total;
    approvalDeadlines.set(key, deadline);
    remainingMs = Math.max(0, deadline - Date.now());
    const tick = () => {
      const left = deadline - Date.now();
      if (left <= 0) {
        remainingMs = 0;
        clearInterval(interval);
      } else {
        remainingMs = left;
      }
    };
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  });

  // --- Keyboard + focus for the blocking dialog (mirrors QnaForm) ---
  // The approval sheet is the app's only *agent-initiated* blocking modal, so it must
  // be perceivable and operable without a pointer: focus moves into it on open, Esc
  // cancels (deny-safe), ⌘/Ctrl+Enter submits the affirmative action, and Tab is
  // trapped inside. Keydown lives on the sheet (focus is inside it after open) to avoid
  // clashing with the global ⌘↑ / composer-Esc handlers.
  let sheetEl = $state<HTMLElement | null>(null);

  function focusSheet(): void {
    if (!sheetEl) return;
    const el = sheetEl;
    // Focus the field if there is one (input/editor → soft keyboard opens + immediate
    // typing); otherwise focus the sheet itself (tabindex=-1) so a screen reader
    // announces the dialog without pre-arming an affirmative button for an accidental
    // Enter. Approving is then deliberate: Tab/click, or ⌘/Ctrl+Enter. (Mirrors QnaForm.)
    queueMicrotask(() => {
      (el.querySelector<HTMLElement>(".field, .editor") ?? el).focus();
    });
  }

  $effect(() => {
    const id = current?.requestId;
    if (!id || !sheetEl) return;
    focusSheet(); // fires on first render of each new dialog
  });
  // Re-focus when cycled back to via ⌘\ (the requestId effect above won't re-fire —
  // the request is unchanged across a minimize→restore cycle).
  $effect(() => {
    if (
      attention.focused === "approval" &&
      !attention.minimized.approval
    ) {
      focusSheet();
    }
  });

  // Remote-resolution cleanup: when the underlying request changes or becomes null
  // (resolved by another client, auto-timeout, etc.), clear the controller's approval
  // state so the pill disappears and a fresh dialog starts un-minimized. Mirrors
  // QnaInline's lastRequestId pattern (a plain guard, not an effect teardown —
  // teardowns fire on every effect re-run, which would clear mid-cycle).
  let lastApprovalId: string | undefined;
  $effect(() => {
    const id = current?.requestId;
    if (id !== lastApprovalId) {
      if (lastApprovalId !== undefined) attention.clear("approval");
      disarmPlanCancel();
      lastApprovalId = id;
    }
  });

  // The affirmative action for the current kind. Non-binary selects have no single
  // primary (the user picks an option), so this is a no-op there.
  function primaryAction(): void {
    const c = current;
    if (!c) return;
    if (c.kind === "confirm") confirm(true);
    else if (c.kind === "input" || c.kind === "editor") submitValue(inputValue);
    else if (c.kind === "select" && binarySelect) submitValue(binarySelect.affirmative);
    else if (c.kind === "plan") submitValue(c.actionLabels[0]);
  }

  // Arrow-key roving for the non-binary select (a radiogroup). ↑/↓ move focus between
  // options (wrapping), Home/End jump to ends; the focused option's `onfocus` marks it
  // selected. Clicking or Enter/Space (native button activation) submits that option.
  function onOptionsKeydown(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const els = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".opt"),
    ];
    if (els.length === 0) return;
    const idx = els.findIndex((el) => el === document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? els.length - 1
          : e.key === "ArrowDown"
            ? idx < 0
              ? 0
              : (idx + 1) % els.length
            : idx < 0
              ? els.length - 1
              : (idx - 1 + els.length) % els.length;
    els[next]?.focus();
  }

  function onSheetKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (current?.kind === "plan" && planCancelArmed) {
        disarmPlanCancel();
        return;
      }
      cancel();
      return;
    }
    if (e.key === "Enter") {
      // ⌘/Ctrl+Enter submits from anywhere (incl. the editor, where bare Enter is a
      // newline). A single-line input also submits on bare Enter. Bare Enter for
      // confirm/select is left to native button activation (the primary is focused).
      const bareInputSubmit = current?.kind === "input" && !e.shiftKey;
      if (e.metaKey || e.ctrlKey || bareInputSubmit) {
        e.preventDefault();
        primaryAction();
      }
      return;
    }
    if (e.key === "Tab" && sheetEl) {
      const f = sheetEl.querySelectorAll<HTMLElement>(
        'button, input, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

{#if current}
  {#if !minimized}
    <div class="scrim" onclick={scrimClick} role="presentation"></div>
    <div
      class="sheet"
      class:plan={current.kind === "plan"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      tabindex="-1"
      bind:this={sheetEl}
      onkeydown={onSheetKeydown}
    >
      <div class="grip"></div>
      {#if store.phoneLayout && pending.length > 1}
        <nav class="request-nav" aria-label="Pending requests">
          <button type="button" onclick={() => moveMobile(-1)} title="Previous pending request" aria-label="Previous pending request">Previous</button>
          <span>{mobileIndex + 1} of {pending.length}</span>
          <button type="button" onclick={() => moveMobile(1)} title="Next pending request" aria-label="Next pending request">Next</button>
        </nav>
      {/if}
      <button
        type="button"
        class="min"
        onclick={minimize}
        aria-expanded="true"
        aria-label={store.phoneLayout ? "Minimize approval" : "Minimize to pill"}
        title={store.phoneLayout ? "Minimize approval" : "Minimize to pill (⌘\\)"}
      >
        <Chevron open={true} size={11} />
        {#if store.phoneLayout}<span>Minimize</span>{/if}
      </button>

    {#if current.kind === "confirm"}
      <h2 id="approval-title">{current.title}</h2>
      <p class="msg">{current.message}</p>
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Deny this request" onclick={() => confirm(false)}>Deny</Button>
        <Button variant="primary" size="lg" block title="Allow this request" onclick={() => confirm(true)}>Allow</Button>
      </div>
    {:else if current.kind === "select"}
      <h2 id="approval-title">{current.title}</h2>
      {#if binarySelect}
        <div class="actions two">
          <Button variant="secondary" size="lg" block title={binarySelect.negative} onclick={() => submitValue(binarySelect.negative)}>{binarySelect.negative}</Button>
          <Button variant="primary" size="lg" block title={binarySelect.affirmative} onclick={() => submitValue(binarySelect.affirmative)}
            >{binarySelect.affirmative}</Button
          >
        </div>
      {:else}
        <div
          class="options"
          role="radiogroup"
          aria-labelledby="approval-title"
          tabindex="-1"
          onkeydown={onOptionsKeydown}
        >
          {#each current.options as opt (opt)}
            <button
              class="opt"
              class:sel={selectedOption === opt}
              role="radio"
              aria-checked={selectedOption === opt}
              tabindex={(selectedOption ?? current.options[0]) === opt ? 0 : -1}
              title={`Choose: ${opt}`}
              onclick={() => submitValue(opt)}
              onfocus={() => { selectedOption = opt; rememberDraft(); }}>{opt}</button
            >
          {/each}
        </div>
        <div class="actions"><Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button></div>
      {/if}
    {:else if current.kind === "plan"}
      <h2 id="approval-title">{current.title}</h2>
      {#if current.displayPath}
        <p class="plan-path" title="Plan document path">{current.displayPath}</p>
      {/if}
      <div class="plan-body">
        <Markdown content={current.planText} final />
      </div>
      <div class="actions three">
        <Button variant="secondary" size="lg" block class={planCancelArmed ? "armed" : ""} title={planCancelArmed ? "Click again to cancel" : current.actionLabels[2]} onclick={attemptPlanCancel}>{planCancelLabel}</Button>
        <Button variant="secondary" size="lg" block title={current.actionLabels[1]} onclick={() => submitValue(current.actionLabels[1])}>{current.actionLabels[1]}</Button>
        <Button variant="primary" size="lg" block title={current.actionLabels[0]} onclick={() => submitValue(current.actionLabels[0])}>{current.actionLabels[0]}</Button>
      </div>
    {:else if current.kind === "input"}
      <h2 id="approval-title">{current.title}</h2>
      <input class="field" value={inputValue} oninput={(e) => { inputValue = e.currentTarget.value; rememberDraft(); }} placeholder={current.placeholder ?? ""} />
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button>
        <Button variant="primary" size="lg" block title="Submit your input" onclick={() => submitValue(inputValue)}>Submit</Button>
      </div>
    {:else if current.kind === "editor"}
      <h2 id="approval-title">{current.title}</h2>
      <textarea class="editor" value={inputValue} oninput={(e) => { inputValue = e.currentTarget.value; rememberDraft(); }} rows="6"></textarea>
      <div class="actions two">
        <Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button>
        <Button variant="primary" size="lg" block title="Save your edits" onclick={() => submitValue(inputValue)}>Save</Button>
      </div>
    {:else if current.kind === "permission"}
      <h2 id="approval-title">{current.title}</h2>
      {#if current.toolName}
        <p class="tool-name" title="The tool requesting approval">{current.toolName}</p>
      {/if}
      {#if current.toolInput}
        <pre class="tool-input" title="The tool's input (JSON)">{current.toolInput}</pre>
      {/if}
      <div
        class="options"
        role="radiogroup"
        aria-labelledby="approval-title"
        tabindex="-1"
        onkeydown={onOptionsKeydown}
      >
        {#each current.options as opt (opt)}
          <button
            class="opt"
            class:sel={selectedOption === opt}
            role="radio"
            aria-checked={selectedOption === opt}
            tabindex={(selectedOption ?? current.options[0]) === opt ? 0 : -1}
            title={`Choose: ${opt}`}
            onclick={() => submitValue(opt)}
            onfocus={() => { selectedOption = opt; rememberDraft(); }}>{opt}</button
          >
        {/each}
      </div>
      <div class="actions"><Button variant="secondary" size="lg" block title="Cancel this request" onclick={cancel}>Cancel</Button></div>
    {:else if current.kind === "unknown"}
      <h2 id="approval-title">{current.title}</h2>
      <p class="msg">{current.message}</p>
      <div class="actions"><Button variant="secondary" size="lg" block title="Dismiss this request" onclick={cancel}>Dismiss</Button></div>
    {:else if isDialogRequest(current)}
      <!-- unreachable: all dialog kinds handled above -->
    {:else}
      <!-- generic fallback for any unknown/unhandled method -->
      <h2 id="approval-title">Agent request: {current.kind}</h2>
      <pre class="raw">{JSON.stringify(current, null, 2)}</pre>
      <div class="actions"><Button variant="secondary" size="lg" block title="Dismiss this request" onclick={cancel}>Dismiss</Button></div>
    {/if}

    {#if timeoutMs}
      <div class="countdown" role="timer" aria-live="off">
        <div class="track"><div class="bar" style:width={`${progress * 100}%`}></div></div>
        <span class="countdown-label">Auto-dismiss in {remainingSec}s</span>
      </div>
    {/if}

    {#if store.session.pendingApprovals.length > 1}
      <div class="queued">+{store.session.pendingApprovals.length - 1} more pending</div>
    {/if}
    </div>
  {:else}
    {#key current.requestId}
      <div transition:reveal>
        <button
          type="button"
          class="attention-pill"
          onclick={() => attention.restore("approval")}
          title="Approval pending — click or press ⌘\ to restore"
        >
          <span class="pill-count">{store.session.pendingApprovals.filter((r) => r.kind !== "qna").length}</span>
          <span class="pill-label">approval{store.session.pendingApprovals.filter((r) => r.kind !== "qna").length > 1 ? "s" : ""} pending</span>
        </button>
      </div>
    {/key}
  {/if}
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(20, 19, 18, 0.32);
    z-index: 40;
    animation: fade 0.15s ease;
  }
  .sheet {
    position: absolute;
    z-index: 41;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(520px, 100%);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    box-shadow: var(--shadow-pop);
    padding: 14px 20px calc(22px + env(safe-area-inset-bottom));
    animation: rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .request-nav { display: none; }
  @media (max-width: 859px) {
    .scrim { display: none; }
    .sheet, .sheet.plan {
      position: absolute; inset: 0; left: 0; bottom: 0; transform: none;
      width: 100%; max-height: none; border: 0; border-radius: 0; box-shadow: none;
      padding: max(64px, calc(52px + env(safe-area-inset-top))) 18px max(16px, env(safe-area-inset-bottom));
      overflow-y: auto; overscroll-behavior: contain; animation: fade 0.15s ease;
      background: var(--bg-elevated);
    }
    .grip { display: none; }
    .request-nav {
      position: absolute; top: env(safe-area-inset-top); left: 8px; right: 116px;
      display: flex; min-height: 52px; align-items: center; justify-content: space-between;
      color: var(--text-faint); font-size: 12px;
    }
    .request-nav button {
      min-width: 72px; min-height: 44px; border: 0; background: transparent;
      color: var(--text-muted); font: inherit;
    }
  }
  @media (min-width: 600px) {
    .sheet {
      bottom: 28px;
      border-radius: 18px;
      border-bottom: 1px solid var(--border);
    }
  }
  /* Plan handoff: a plan is a full document, not a one-line question — take
     nearly the whole chat pane (a sliver of scrim stays visible so it still
     reads as an overlay). Flex column so the markdown body gets the height
     and scrolls while the header + actions stay pinned. */
  .sheet.plan {
    display: flex;
    flex-direction: column;
    max-height: calc(100% - 20px);
  }
  @media (min-width: 600px) {
    .sheet.plan {
      width: calc(100% - 48px);
      bottom: 24px;
      max-height: calc(100% - 48px);
    }
  }
  .grip {
    width: 36px;
    height: 4px;
    border-radius: 99px;
    background: var(--border-strong);
    margin: 0 auto 12px;
  }
  h2 {
    font-size: 16px;
    margin: 0 0 8px;
    font-weight: 600;
  }
  .msg {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 16px;
    line-height: 1.5;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
    flex-shrink: 0;
  }
  /* Action labels come from the daemon (arbitrary length) — wrap inside the
     button instead of overflowing the sheet (the Button primitive defaults to
     nowrap for compact chrome). */
  .actions :global(.btn) {
    white-space: normal;
    min-width: 0;
  }
  /* Armed (click-twice confirm): destructive red so the operator sees the
     consequence of a second click. Mirrors ContextMeter's .action.armed. */
  .actions :global(.btn.armed) {
    color: var(--danger);
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
  .actions :global(.btn.armed:hover) {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
  }
  .actions.two {
    flex-direction: row;
  }
  /* Plan handoff: 3 actions (Cancel | Implement here | Implement new). Stacks to
     a single column on narrow (phone) widths so each button is a full-width tap
     target rather than a cramped third. */
  .actions.three {
    flex-direction: column;
  }
  @media (min-width: 600px) {
    .actions.three {
      flex-direction: row;
      flex-wrap: wrap;
    }
  }
  .plan-path {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 12px;
    margin: 0 0 12px;
    word-break: break-all;
  }
  .plan-body {
    max-height: 50vh;
    overflow-y: auto;
    /* Subtle scroll affordance without a heavy scrollbar on touch. */
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  /* In the near-full plan sheet the body takes the flexible height instead of a
     fixed viewport fraction (min-height lets it actually shrink in the flexbox). */
  .sheet.plan .plan-body {
    max-height: none;
    flex: 1;
    min-height: 0;
  }
  .tool-name {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 13px;
    margin: 0 0 8px;
  }
  .tool-input {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.45;
    color: var(--text);
    max-height: 180px;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    margin: 0 0 4px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .opt {
    display: flex;
    align-items: center;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    font-size: 15px;
    color: var(--text);
  }
  /* Touch: a comfortable tap target for each blocking choice. */
  @media (pointer: coarse) {
    .opt {
      min-height: 44px;
    }
  }
  .opt:active,
  .opt.sel {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .field,
  .editor {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 13px;
    font-size: 15px;
    color: var(--text);
    font-family: inherit;
    outline: none;
  }
  .field:focus,
  .editor:focus {
    border-color: var(--accent);
  }
  .editor {
    resize: vertical;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .raw {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 11px;
    font-family: var(--font-mono);
    font-size: 12px;
    max-height: 240px;
    overflow: auto;
    margin: 0;
  }
  .queued {
    text-align: center;
    color: var(--text-faint);
    font-size: 12px;
    margin-top: 12px;
  }
  .countdown {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .track {
    width: 100%;
    height: 3px;
    border-radius: 99px;
    background: var(--surface-sunken);
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    border-radius: 99px;
    transition: width 0.25s linear;
  }
  .countdown-label {
    color: var(--text-faint);
    font-size: 12px;
  }
  @keyframes rise {
    from {
      transform: translate(-50%, 16px);
      opacity: 0;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .scrim,
    .sheet {
      animation: none;
    }
  }
  /* Minimize button in the sheet header — mirrors QnaForm's .min. */
  .min {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
  }
  .min span { display: none; }
  @media (max-width: 859px) {
    .min {
      top: env(safe-area-inset-top); right: 8px; width: auto; min-width: 104px;
      height: 52px; border: 0; gap: 8px; padding: 0 12px;
    }
    .min span { display: inline; }
  }
  .min :global(.chevron) {
    color: inherit;
  }
  .min:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  /* Minimized pill — reuses TaskList's .pill visual language. Positioned at the
     bottom of the chat column where the sheet would be. */
  .attention-pill {
    position: absolute;
    z-index: 41;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    color: var(--text-muted);
    background: var(--highlight-soft);
    border: 1px solid color-mix(in srgb, var(--highlight) 42%, var(--border));
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    max-width: 100%;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  @media (max-width: 859px) { .attention-pill { display: none; } }
  .attention-pill:hover {
    color: var(--text);
    border-color: var(--highlight);
  }
  .attention-pill:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .pill-count {
    font-variant-numeric: tabular-nums;
    font-weight: 550;
    color: var(--text);
  }
  .pill-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>

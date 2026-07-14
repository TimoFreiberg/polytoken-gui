<script lang="ts">
  import { onMount } from "svelte";
  import type { CommandInfo } from "@pantoken/protocol";
  import { store } from "../lib/store.svelte.js";
  import {
    extractAtQuery,
    filterFiles,
    classifyAtQuery,
    buildAtItems,
    stepLevel,
    type AtItem,
  } from "../lib/file-autocomplete.js";
  import {
    IMAGE_LIMITS,
    prepareImageFiles,
  } from "../lib/image-attachments.js";
  import { filterCommands, slashQuery } from "../lib/slash.js";
  import { nextHistoryIndex } from "../lib/prompt-history.js";
  import {
    caretOnFirstVisualLine,
    caretOnLastVisualLine,
  } from "../lib/caret-visual-line.js";
  import { contextTone } from "../lib/context-tone.js";
  import SlashMenu from "./SlashMenu.svelte";
  import AtMenu from "./AtMenu.svelte";
  import DirPicker from "./DirPicker.svelte";
  import ImageLightbox from "./ImageLightbox.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import FacetBadge from "./FacetBadge.svelte";
  import PermissionBadge from "./PermissionBadge.svelte";
  import ContextMeter from "./ContextMeter.svelte";
  import IconButton from "./ui/IconButton.svelte";
  import Chevron from "./ui/Chevron.svelte";
  import TaskList from "./TaskList.svelte";
  import QueueTray from "./QueueTray.svelte";
  import PromptHistoryMenu from "./PromptHistoryMenu.svelte";
  import { parseTasklist } from "../lib/tasklist.js";

  let ta = $state<HTMLTextAreaElement>();
  let box = $state<HTMLDivElement>();
  let fileInput = $state<HTMLInputElement>();
  // Expand toggle: collapsed keeps the composer modest so more of the session
  // shows; expanded trades that for reading a long prompt whole. Auto-resets on send.
  let expanded = $state(false);
  // Tracked so the caps re-derive on window resize (the cap scales with viewport).
  let winH = $state(window.innerHeight);

  // Image attachments: picked from the browser file input, read as base64.
  const images = $derived(store.composerImages);
  const imageCount = $derived(images.length);
  // Index of the attachment shown full-screen, or null when the lightbox is closed.
  let lightboxIndex = $state<number | null>(null);
  let submitting = $state(false);
  let addingImages = $state(false);
  let attachmentStatus = $state<{
    kind: "error" | "info";
    text: string;
  } | null>(null);
  let dragDepth = 0;
  let dragActive = $state(false);

  // Ambient widgets above the composer. The "tasklist" widget gets a collapsed
  // pill (parsed from its lines) that expands on hover/click; everything else
  // renders as the raw monospace box. A tasklist whose lines don't parse (format
  // drift / empty) falls back to the box too — never an empty pill.
  // Suppressed while drafting a new session: the draft is a client overlay over the
  // previously-focused session, so its ambient state (e.g. that session's tasklist)
  // would otherwise bleed into the new-session view it doesn't belong to.
  const widgets = $derived(
    store.draft != null
      ? []
      : Object.values(store.session.ambient.widgets)
          .filter((w) => w.placement === "aboveComposer")
          .map((w) => ({
            w,
            tasks: w.key === "tasklist" ? parseTasklist(w.lines) : null,
          })),
  );
  // "A turn is in flight" — the robust signal (see store.turnActive), so the stop pill +
  // steer/queue affordances stay correct even if the folded status glitches mid-turn.
  const streaming = $derived(store.turnActive);
  // The stop action has its own acknowledgement lifecycle. Keep it distinct from
  // `streaming`: a broken daemon can still be running while the ordinary Stop pill
  // has become an explicit recovery action.
  const stopState = $derived(store.stopState);
  // Drafting a brand-new session: the composer doubles as the new-session form (config
  // chips above, first prompt below). Send creates the session + delivers the prompt.
  const drafting = $derived(store.draft != null);
  // Touch-primary device (phone/tablet): a bare Enter inserts a newline rather than
  // sending, so multi-line prompts are possible from a soft keyboard (send is the button
  // or ⌘/Ctrl+Enter). Uses maxTouchPoints — NOT `(hover: none)`, which headless Chromium
  // misreports — matching Transcript/Sidebar; the Pixel 7 e2e project sets hasTouch so the
  // path is covered.
  const isTouch =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  // Context-window pressure cue: the meter ring escalates by color but never says
  // "you're running out" in words. Once the active session's window is ≥85% full, surface
  // a one-line nudge above the composer toward /compact or a fresh session. While drafting,
  // store.session still holds the PREVIOUS session — suppress the cue rather than show its
  // pressure; the tone tracks the ring (accent 85–89, danger 90+).
  const contextPct = $derived(
    drafting ? null : (store.session.usage?.percent ?? null),
  );
  const contextCue = $derived(
    contextPct !== null && contextPct >= 85
      ? { pct: Math.round(contextPct), tone: contextTone(contextPct) }
      : null,
  );
  // Project chip → server-side directory browser (DirPicker). The path is chosen on the
  // server's filesystem because the agent runs server-side; a native picker would see the client.
  let pickingCwd = $state(false);
  // Never carry an open picker across drafts (it would auto-pop on the next new session).
  $effect(() => {
    if (!drafting) pickingCwd = false;
  });
  // Distinct project dirs from existing sessions, most-recent first — surfaced as one-tap
  // shortcuts atop the directory browser so a known project is a pick, not a full retype.
  const recentCwds = $derived.by(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...store.sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )) {
      const dir = s.worktree?.base ?? s.cwd;
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
    return out;
  });
  const cwdBase = $derived.by(() => {
    const c = store.draft?.cwd?.replace(/\/+$/, "") ?? "";
    return c ? (c.split("/").pop() ?? c) : "home";
  });
  // --- Slash-command typeahead. The menu is open when the draft is a bare slash token
  // (slashQuery != null), the user hasn't dismissed it for this token, and there are
  // matches to show. Selection + dismissal are this component's state; the menu itself
  // is presentational. Execution is free: sending `/name args` is a normal prompt, and
  // the agent's prompt() runs the command / expands the template.
  let slashSel = $state(0);
  let slashDismissed = $state(false);
  const slashQ = $derived(slashQuery(store.composerDraft));
  const slashItems = $derived(
    slashQ === null ? [] : filterCommands(store.commands, slashQ),
  );
  const slashOpen = $derived(
    slashQ !== null && !slashDismissed && slashItems.length > 0,
  );
  // Keep the highlighted index in range as the filtered list shrinks under the cursor.
  $effect(() => {
    if (slashSel >= slashItems.length) slashSel = 0;
  });

  // --- Ctrl+R prompt-history popup. Shows recent prompts above the textarea;
  //   arrow-key navigate, Enter fills the composer. Mirrors the polytoken TUI.
  let historyOpen = $state(false);
  let historySel = $state(0);
  // $state: passed as a prop to the mounted popup — a reassignment while it's
  // open (re-opening over fresh history) must re-render the list.
  let historyItems = $state<string[]>([]);
  function openHistory() {
    historyItems = [...store.currentPromptHistory].reverse(); // newest first
    if (historyItems.length === 0) return;
    historySel = 0;
    historyOpen = true;
  }
  function closeHistory() {
    historyOpen = false;
  }
  function acceptHistory(text: string) {
    store.composerDraft = text;
    closeHistory();
    queueMicrotask(() => {
      autosize();
      if (ta) {
        const end = store.composerDraft.length;
        ta.selectionStart = ta.selectionEnd = end;
        cursorPos = end;
        ta.focus();
      }
    });
  }

  // --- Cursor tracking (textarea). Needed so @-mentions work inline, not just at
  // the end of the draft. Updated on every input/click/keyboard event.
  let cursorPos = $state(0);

  // --- Readline-style prompt history (ArrowUp/ArrowDown). `histIndex` is the navigation
  // cursor: null = showing the live draft, otherwise an index into store.currentPromptHistory.
  // `histWip` stashes the live draft when navigation starts so ArrowDown can restore it;
  // `histNavKey` records the composer key (session/draft) navigation began under. State resets
  // on a fresh keystroke (onInput), after a send, and — lazily, at keypress time — when the
  // composer has since re-pointed at a different session/draft. Resetting lazily (rather than
  // via an $effect on store.session) avoids a transient boot re-snapshot nulling the cursor
  // mid-navigation.
  let histIndex: number | null = null;
  let histWip = "";
  let histNavKey = "";
  // The composer's current history context — mirrors store.composerDraftKey (which is private),
  // so a session/draft switch invalidates an in-progress navigation.
  function composerKey(): string {
    return store.draft
      ? `n:${store.draft.cwd}`
      : (store.session.ref?.sessionId ?? "");
  }

  // --- @-reference autocomplete (files, skills, subagents, models — hybrid: instant
  // local matching + server fallback for project files, server-only for external paths).
  // Same shape as slash: an active query (the text after `@` at/before cursor), a
  // highlighted index, and a dismissed flag so Esc closes it for this token.
  // `classifyAtQuery` (in `buildAtItems`) decides which kind the query addresses —
  // skills/subagents come from `store.atRefs` and models from `store.models`, both
  // already pushed/fetched, no round-trip needed. The server pushes the focused session's
  // full file index on switch (store.fileIndex); `filterFiles` ranks it locally on every
  // keystroke, so the "project" mode menu updates synchronously — no round-trip, and no
  // hide/show flicker (the old per-query RPC blanked the menu for the in-flight window).
  // Project mode only falls back to a debounced server `fd` search (store.queryFiles) when
  // the index was truncated (a cwd larger than the server cap) AND local matches are thin,
  // merging its results into the local ones. "external" mode (`~/…`, `/…`, `../…`) has no
  // local index at all — there's nothing to prefetch for paths outside the project — so it
  // ALWAYS uses the debounced server query; see the effect below.
  const AT_MENU_LIMIT = 50;
  // Fire the server fallback only when local matches are thinner than this — a comfortably
  // full menu means the wanted file is almost certainly already shown, so don't round-trip.
  const FALLBACK_MIN = 25;
  let atSel = $state(0);
  let atDismissed = $state(false);
  // Model reasoning level (polytoken TUI parity): `[`/`]` step the highlighted model
  // row's level while it's a "model" item (see the atOpen keydown block below); the
  // selected row renders it as `reasoning: <level>`, and accepting appends `(<level>)`.
  // `null` = no level chosen (unchanged accept: plain `@model:provider/modelId`). Reset
  // effect is below, alongside atQ/atOpen (which it depends on).
  let modelLevel = $state<string | null>(null);
  // Shift+Tab ignore-rules toggle (polytoken TUI parity): while true, the picker bypasses
  // the local index entirely and always server-queries with `includeIgnored: true`, so
  // hidden dotfiles and gitignored entries join the candidates (project AND external
  // modes — see the keydown block and the debounced-fallback effect below). Unlike
  // `modelLevel` this must SURVIVE further typing within the same mention (so narrowing
  // the query after revealing `.env` doesn't immediately hide it again) — its reset effect
  // (below, near `atDismissed`) is keyed on the active token's identity (`atTokenPos`) and
  // an explicit Escape-dismiss, not on `atQ`'s text or `atOpen` (see that effect's comment
  // for why `atOpen` specifically would create a feedback loop here).
  let ignoreOff = $state(false);
  let fileDebounce: ReturnType<typeof setTimeout> | undefined;
  const atMatch = $derived(extractAtQuery(store.composerDraft, cursorPos));
  const atQ = $derived(atMatch?.query ?? null);
  // Identifies WHICH `@` is the active mention (its position in the draft), as opposed to
  // `atQ`'s text content, which changes on every keystroke. Used only to scope
  // `ignoreOff`'s reset to "a different/no mention became active", not "the same mention's
  // text changed".
  const atTokenPos = $derived(atMatch?.atPos ?? null);
  const atClass = $derived(atQ === null ? null : classifyAtQuery(atQ));
  // Instant local matches over the prefetched index — the dominant path. Suppressed while
  // drafting a new session: the pushed index is the previously-focused session's cwd, so its
  // files are wrong for the draft's target project. A draft searches via the server fallback
  // (scoped to the draft cwd) instead. Also suppressed while `ignoreOff` is toggled on — the
  // local index never carries the hidden/gitignored entries the toggle wants revealed, so
  // it's server-only for the duration (Composer bypasses it entirely). Only meaningful in
  // project mode; used here purely as the "are local matches thin" signal for the fallback
  // effect below (buildAtItems below does its own filtering over the full index for the
  // actual menu items).
  const localFileItems = $derived(
    atQ === null || drafting || ignoreOff
      ? []
      : filterFiles(store.fileIndex.files, atQ, AT_MENU_LIMIT),
  );
  // Server fallback results, but only while they match the *current* query AND toggle state
  // (both echoed back by the server) — either one being stale (an in-flight response from a
  // newer keystroke, or from before/after a Shift+Tab flip) must not land in the menu.
  const serverFileItems = $derived(
    atQ !== null &&
      store.files.query === atQ &&
      store.files.includeIgnored === ignoreOff
      ? store.files.items
      : [],
  );
  // The full kind-aware menu list: file/skill/subagent/model/sigil rows, built by the pure
  // `buildAtItems` helper so the ordering/filtering logic is unit-testable independent of
  // this component. `files` is emptied while drafting or ignoreOff-toggled (see
  // localFileItems above) — the server is the sole source in either case.
  const atItems = $derived.by((): AtItem[] => {
    if (atQ === null) return [];
    return buildAtItems({
      query: atQ,
      files: drafting || ignoreOff ? [] : store.fileIndex.files,
      serverFiles: serverFileItems,
      skills: store.atRefs.skills,
      subagents: store.atRefs.subagents,
      models: store.models,
      limit: AT_MENU_LIMIT,
    });
  });
  const atOpen = $derived(
    atQ !== null && !atDismissed && atItems.length > 0,
  );
  // Whether the current mode's candidates are affected by the ignore-rules toggle at all —
  // only file browsing (project/external) has a notion of "hidden"/"gitignored"; skill/
  // subagent/model takeovers have no such concept. Drives the AtMenu footer hint.
  const ignoreToggleApplies = $derived(
    atClass?.mode === "project" || atClass?.mode === "external",
  );
  $effect(() => {
    if (atSel >= atItems.length) atSel = 0;
  });
  // The selected row or the active query moving invalidates any level dialed in for
  // the previous model — mirrors the atSel-out-of-range reset just above. Also fires
  // when the menu closes (atOpen false) so a dismissed/closed picker never leaves a
  // stale level behind for the next time it opens.
  $effect(() => {
    atSel;
    atQ;
    atOpen;
    modelLevel = null;
  });
  // ignoreOff resets when the ACTIVE MENTION ITSELF changes (a different `@`, or none at
  // all — `atTokenPos`) or the menu is explicitly dismissed (Escape — `atDismissed`) —
  // deliberately NOT on every `atQ` keystroke like modelLevel above, so continuing to
  // narrow the query while the toggle is on doesn't immediately re-hide what it just
  // revealed. Also deliberately NOT keyed on `atOpen`: toggling `ignoreOff` on is ITSELF
  // what flips a zero-local-match menu open once the server responds (bypassing the local
  // index and waiting on `serverFileItems`) — depending on `atOpen` here would reset the
  // toggle the instant that response arrived and the menu opened, undoing itself in a
  // feedback loop (open → reset → server items invalidated by the guard → closes again).
  $effect(() => {
    atTokenPos;
    atDismissed;
    ignoreOff = false;
  });

  // Debounced server fallback: ALWAYS fires in external mode (`~/…`, `/…`, `../…`) —
  // there's no local index for paths outside the project, so the server is the only
  // source. In project (file) mode it fires only when the index was truncated and local
  // matches are thin (the wanted file may live past the cap), OR always while drafting
  // (no session index exists for the draft's target cwd, so the server `fd` search
  // scoped to that cwd is the only source), OR always while `ignoreOff` is toggled on
  // (the local index never has hidden/gitignored entries, so the truncated/thin gating is
  // suspended for the duration). Skill/subagent/model modes never reach the server here —
  // their sources are already local (atRefs/models). The common non-draft, untoggled
  // project-file case never reaches the server either.
  $effect(() => {
    const q = atQ;
    // Read explicitly (not just inside the setTimeout closure below) so toggling
    // Shift+Tab — with nothing else about the active mention changing — still
    // re-triggers this effect and re-fires the query with the new flag value.
    const off = ignoreOff;
    const needFallback =
      q !== null &&
      (atClass?.mode === "external" ||
        (atClass?.mode === "project" &&
          (drafting ||
            off ||
            (store.fileIndex.truncated && localFileItems.length < FALLBACK_MIN))));
    clearTimeout(fileDebounce);
    if (!needFallback) return;
    // A draft searches its target project dir (typed cwd, or $HOME when blank); a real
    // session lets the server use its focused cwd (undefined). Same resolution for
    // external mode — the server resolves `~`/`..` against its own $HOME/session cwd
    // regardless of which cwd (if any) is passed here.
    const cwd = drafting
      ? store.draft?.cwd.trim() || store.defaultNewSessionCwd
      : undefined;
    fileDebounce = setTimeout(() => {
      if (q !== null) store.queryFiles(q, cwd, off);
    }, 150);
    return () => clearTimeout(fileDebounce);
  });

  // Max textarea height in px. Collapsed: floor at 3 lines so a scrollbar
  // never shows below that, grow a little with the window, cap ~6.5 lines. Expanded:
  // up to 62vh (well under "eats the whole screen") so a long prompt is readable.
  const maxH = $derived(
    expanded ? Math.min(winH * 0.62, 560) : Math.max(80, Math.min(winH * 0.22, 168)),
  );

  function autosize() {
    if (box) box.style.setProperty("--composer-max", `${maxH}px`);
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }

  // Re-fit whenever the cap changes (expand toggle or window resize).
  $effect(() => {
    maxH;
    autosize();
  });

  // The model/effort picker asks for focus back here after a keyboard-driven close
  // (select or Esc). A counter so each request re-fires; guarded so the initial
  // run never grabs focus (which would pop the keyboard on mobile / page load).
  let lastFocusN = 0;
  $effect(() => {
    const n = store.focusComposerN;
    if (n !== lastFocusN) {
      lastFocusN = n;
      queueMicrotask(() => ta?.focus());
    }
  });

  // Persist the in-progress draft on a debounced cadence so a reload / tab eviction
  // mid-typing doesn't lose it (switch + pagehide stash too; this covers the gap). The
  // effect re-runs on every keystroke; its cleanup resets the timer, giving the debounce.
  let stashTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const text = store.composerDraft; // track
    // Re-fit the box when the draft changes programmatically (a restored draft on
    // session switch / boot — `oninput` only covers user typing).
    void text;
    autosize();
    clearTimeout(stashTimer);
    stashTimer = setTimeout(() => store.stashDraft(), 400);
    return () => clearTimeout(stashTimer);
  });

  // Submit the composer text. Enter always sends — the polytoken driver routes
  // mid-turn sends to the queue (/turn/input) and idle sends to a new turn
  // (/prompt), so there's no separate steer/follow-up mode to pick.
  async function submit() {
    if (submitting) return;
    const text = store.composerDraft;
    // Allow an empty prompt to act as a "continue" signal when the agent is
    // idle (parity with the polytoken TUI). Block it mid-turn (empty steer)
    // and when drafting a new session (empty first message).
    if (!text.trim() && images.length === 0 && (streaming || drafting)) return;
    // These are `$state` proxies; that's fine to pass on. `savePendingPrompt` is the
    // single boundary that rebuilds plain data before IndexedDB's structured clone.
    const imgs = images.length > 0 ? images : undefined;
    submitting = true;
    let queued = false;
    try {
      queued = drafting
        ? await store.submitDraft(text, imgs)
        : await store.prompt(text, undefined, imgs);
    } finally {
      submitting = false;
    }
    if (!queued) return;
    pickingCwd = false;
    expanded = false;
    attachmentStatus = null;
    // Restart history navigation so the next ArrowUp recalls the just-sent prompt.
    histIndex = null;
    histWip = "";
    queueMicrotask(autosize);
  }


  // Esc while a turn runs: abort it. If the agent hasn't produced any output yet AND the
  // composer is empty (not mid-typing a queued/steer message), pull the just-sent prompt
  // back into the box to edit/resend. History is left alone — the orphaned user message
  // stays. Composer-scoped (textarea-focused) on purpose: a window-level Esc would race
  // the other Esc handlers (ModelPicker, Settings, Sidebar menu, QnaForm, Tooltip). After
  // send the textarea keeps focus, so this covers the dominant flow; Stop covers the rest.
  function abortFromComposer() {
    const restore = store.abortRestoreText;
    store.abort();
    if (restore != null && !store.composerDraft.trim()) {
      store.composerDraft = restore;
      queueMicrotask(() => {
        ta?.focus();
        autosize();
      });
    }
  }

  function toggleExpand() {
    expanded = !expanded;
    queueMicrotask(() => {
      ta?.focus();
      autosize();
    });
  }

  function openFilePicker() {
    if (imageCount >= IMAGE_LIMITS.count) {
      attachmentStatus = {
        kind: "error",
        text: `Only ${IMAGE_LIMITS.count} images can be attached.`,
      };
      return;
    }
    fileInput?.click();
  }

  /** Drop an attachment by index. */
  function removeImage(i: number) {
    store.composerImages = images.filter((_, idx) => idx !== i);
    if (attachmentStatus?.kind === "error") attachmentStatus = null;
    // Keep the lightbox pointed at a valid attachment (or close it when the last goes).
    if (lightboxIndex !== null) {
      const next = store.composerImages.length;
      if (next === 0) lightboxIndex = null;
      else if (lightboxIndex >= next) lightboxIndex = next - 1;
      else if (i < lightboxIndex) lightboxIndex -= 1;
    }
    ta?.focus();
  }

  function closeLightbox() {
    lightboxIndex = null;
    ta?.focus();
  }

  async function addImageFiles(files: readonly File[]) {
    if (addingImages || files.length === 0) return;
    addingImages = true;
    attachmentStatus = null;
    try {
      const result = await prepareImageFiles(files, images);
      if (result.images.length > 0)
        store.composerImages = [...images, ...result.images];
      if (result.errors.length > 0) {
        attachmentStatus = { kind: "error", text: result.errors.join(" ") };
      } else if (result.compressedCount > 0) {
        attachmentStatus = {
          kind: "info",
          text: `Compressed ${result.compressedCount} oversized image${result.compressedCount === 1 ? "" : "s"} before attaching.`,
        };
      }
    } finally {
      addingImages = false;
      ta?.focus();
    }
  }

  async function onFilesSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    // Reset first so re-selecting the same file re-fires even if processing rejects it.
    input.value = "";
    await addImageFiles(files);
  }

  function onPaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files
      ? Array.from(e.clipboardData.files)
      : [];
    if (files.length === 0) return;
    e.preventDefault();
    void addImageFiles(files);
  }

  function hasDraggedFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function onDragEnter(e: DragEvent) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dragActive = true;
  }

  function onDragOver(e: DragEvent) {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent) {
    if (!dragActive) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragActive = false;
  }

  function onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!hasDraggedFiles(e) && files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    dragActive = false;
    if (files.length > 0) void addImageFiles(files);
  }

  function onInput() {
    autosize();
    // Track cursor so @-mentions work inline.
    cursorPos = ta?.selectionStart ?? 0;
    // A user keystroke ends history navigation: the edited text is the new live draft.
    histIndex = null;
    // A fresh keystroke restarts the selection at the top; leaving slash/@-reference mode
    // clears a prior Escape so the next trigger reopens the menu.
    slashSel = 0;
    if (slashQuery(store.composerDraft) === null) slashDismissed = false;
    atSel = 0;
    if (extractAtQuery(store.composerDraft, cursorPos) === null) atDismissed = false;
  }

  // Replace the bare slash token with `/name ` and keep focus so the user types args
  // (the trailing space settles the name, which closes the menu). No send — Enter on a
  // no-arg command fires it on the next keystroke.
  function acceptSlash(cmd: CommandInfo) {
    store.composerDraft = `/${cmd.name} `;
    slashDismissed = false;
    slashSel = 0;
    queueMicrotask(() => {
      ta?.focus();
      autosize();
    });
  }

  /** Replace the @-mention span (`@<query>`) with the canonical text for the picked
   *  item, keeping the cursor right after the inserted text (and trailing
   *  separator, if any — a space for terminal kinds):
   *    - file: directories get a trailing "/" so the user can keep typing to narrow
   *      further.
   *    - skill/subagent: `@skill:<name>` / `@subagent:<name>`.
   *    - model: `@model:<provider>/<modelId>` — always canonical, even if the user
   *      typed the `m:` shorthand — plus a `(<level>)` suffix when a reasoning level
   *      was dialed in with `[`/`]` (unset stays suffix-free).
   *    - sigil: just `@<prefix>` (e.g. `@skill:`) — the cursor lands right after the
   *      colon, so the menu recomputes to that kind's list (same keep-narrowing
   *      mechanic as a directory `/`). */
  function acceptAtItem(item: AtItem) {
    const m = atMatch;
    if (!m) return;
    const draft = store.composerDraft;
    let inserted: string;
    switch (item.kind) {
      case "file":
        inserted = item.file.isDirectory ? `${item.file.path}/` : item.file.path;
        break;
      case "skill":
        inserted = `skill:${item.name}`;
        break;
      case "subagent":
        inserted = `subagent:${item.name}`;
        break;
      case "model":
        inserted = `model:${item.model.provider}/${item.model.modelId}`;
        if (modelLevel !== null) inserted += `(${modelLevel})`;
        break;
      case "sigil":
        inserted = item.prefix;
        break;
    }
    const tail =
      item.kind === "sigil" || (item.kind === "file" && item.file.isDirectory) ? "" : " ";
    store.composerDraft =
      draft.slice(0, m.atPos) + "@" + inserted + tail + draft.slice(cursorPos);
    atDismissed = false;
    atSel = 0;
    modelLevel = null;
    queueMicrotask(() => {
      ta?.focus();
      autosize();
      // Place cursor after the inserted text and trailing separator.
      if (ta) ta.selectionStart = ta.selectionEnd = m.atPos + 1 + inserted.length + tail.length;
    });
  }

  function onKeydown(e: KeyboardEvent) {
    // Pi parity: Alt+Up restores every queued steer/follow-up to the editor. Keep the
    // composer's expand/collapse hotkey on Alt+Shift+Up/Down so the actions don't collide.
    if (
      e.altKey &&
      !e.shiftKey &&
      e.key === "ArrowUp" &&
      !drafting &&
      store.session.queued.length > 0
    ) {
      e.preventDefault();
      store.restoreQueue();
      return;
    }
    if (
      e.altKey &&
      e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      e.preventDefault();
      expanded = e.key === "ArrowUp";
      queueMicrotask(autosize);
      return;
    }
    // New-session draft shortcut: Escape (with an empty prompt and no slash menu open)
    // abandons the draft. ⌥P / ⌥W are handled by the window keydown listener so they
    // also work before the textarea is focused (⌘N leaves it blurred).
    if (drafting) {
      if (e.key === "Escape" && !slashOpen && !atOpen && !store.composerDraft.trim()) {
        e.preventDefault();
        store.cancelDraft();
        return;
      }
    }
    // Ctrl+R: prompt-history popup (polytoken TUI parity). Opens a popup of recent
    // prompts above the textarea; arrow-key navigate, Enter fills the composer.
    if ((e.ctrlKey || e.metaKey) && e.key === "r" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (historyOpen) {
        // Cycle to the next entry (newest-first, so next = older)
        historySel = (historySel + 1) % historyItems.length;
      } else {
        openHistory();
      }
      return;
    }
    // Arrow-key navigation + Enter/Esc while the history popup is open.
    if (historyOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        historySel = Math.min(historySel + 1, historyItems.length - 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        historySel = Math.max(historySel - 1, 0);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        acceptHistory(historyItems[historySel] ?? "");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeHistory();
        return;
      }
    }
    if (slashOpen) {
      const n = slashItems.length;
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
        e.preventDefault();
        slashSel = (slashSel + 1) % n;
        return;
      }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
        e.preventDefault();
        slashSel = (slashSel - 1 + n) % n;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = slashItems[slashSel];
        if (cmd) acceptSlash(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        slashDismissed = true;
        return;
      }
    }
    // Shift+Tab: toggle the ignore-rules picker state (polytoken TUI parity) — hidden
    // dotfiles and gitignored entries join the candidates while on. Gated on
    // `ignoreToggleApplies` (project/external file modes only): skill/subagent/model
    // takeovers have no notion of "ignored", so Shift+Tab there is NOT consumed here —
    // it falls through to the facet-rotate branch below instead. Deliberately checked
    // ahead of (and independent of) the `atOpen`-gated block below: a project-mode query
    // that matches ONLY a currently-hidden dotfile has zero local candidates, so `atOpen`
    // (which additionally requires `atItems.length > 0`) is still false at this point —
    // the menu hasn't rendered yet — but the toggle must still work here, since it's the
    // only way to ever reveal that candidate and make the menu open. MUST also be checked
    // before the atOpen block's own Enter/Tab accept branch below: that branch matches on
    // `e.key === "Tab"` alone, so without this earlier, shift-guarded check it would
    // swallow Shift+Tab as an accept instead of a toggle. Plain Tab (no shift) still
    // falls through to that block's accept, unaffected.
    if (
      ignoreToggleApplies &&
      !atDismissed &&
      e.key === "Tab" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      ignoreOff = !ignoreOff;
      return;
    }
    // Shift+Tab — rotate through facets (issue #19). Fires only when no contextual
    // menu owns Shift+Tab: the @-file ignore-toggle block above already returned for
    // project/external @-mentions, and the slash menu (checked earlier) returns on its
    // own keys. Skill/subagent/model @-takeovers have no ignore-toggle
    // (ignoreToggleApplies is false), so Shift+Tab reaches here and rotates facets
    // instead of the old browser backward-focus-nav fallthrough. ⌘⇧C still opens the
    // full dropdown picker for keyboard selection; this is the quick-rotate shortcut.
    if (
      e.key === "Tab" &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      store.cycleFacet(1);
      return;
    }
    // @-reference keyboard handling (after slash, so slash takes priority if both
    // menus somehow overlap — the user typed `/` first).
    if (atOpen) {
      const n = atItems.length;
      // Model reasoning level (polytoken TUI parity): `[`/`]` step the highlighted
      // model row's level up/down. Only while a model row is selected — every other
      // kind leaves `[`/`]` alone so they type normally (e.g. into a file path).
      const selectedAtItem = atItems[atSel];
      if (
        selectedAtItem?.kind === "model" &&
        (e.key === "[" || e.key === "]") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        modelLevel = stepLevel(
          selectedAtItem.model.thinkingLevels,
          modelLevel,
          e.key === "]" ? 1 : -1,
        );
        return;
      }
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
        e.preventDefault();
        atSel = (atSel + 1) % n;
        return;
      }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
        e.preventDefault();
        atSel = (atSel - 1 + n) % n;
        return;
      }
      // Accept requires an UNSHIFTED Tab: in the file modes Shift+Tab was already
      // consumed by the ignore-toggle branch above, and in skill/subagent/model
      // takeovers (where that branch doesn't apply) Shift+Tab was consumed by the
      // facet-rotate branch above this block. The `!e.shiftKey` guard is belt-and-
      // suspenders: by the time we reach here, Shift+Tab has already been handled.
      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        const item = atItems[atSel];
        if (item) acceptAtItem(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        atDismissed = true;
        return;
      }
    }
    // Readline-style prompt history. Plain ArrowUp on the first *visual* row recalls the
    // previous prompt (an empty field is the degenerate case — the just-sent prompt comes
    // back); ArrowDown on the last visual row walks back toward the live draft. Visual rows
    // respect soft wrap, so a long wrapped paragraph keeps the arrows for caret movement
    // until the caret reaches its top/bottom rendered row. Placed after the slash/file
    // menus, which own the arrows while open.
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      ta &&
      ta.selectionStart === ta.selectionEnd
    ) {
      // A session/draft switch since navigation started invalidates the cursor + stashed WIP.
      const key = composerKey();
      if (histIndex !== null && key !== histNavKey) {
        histIndex = null;
        histWip = "";
      }
      const value = store.composerDraft;
      const up = e.key === "ArrowUp";
      const atEdge = up ? caretOnFirstVisualLine(ta) : caretOnLastVisualLine(ta);
      if (atEdge) {
        const history = store.currentPromptHistory;
        const next = nextHistoryIndex(history.length, histIndex, up ? "up" : "down");
        if (next !== undefined) {
          e.preventDefault();
          if (histIndex === null) {
            histWip = value; // entering nav: stash the live draft + its context
            histNavKey = key;
          }
          histIndex = next;
          const text = next === null ? histWip : (history[next] ?? "");
          store.composerDraft = text;
          queueMicrotask(() => {
            autosize();
            if (ta) {
              const end = store.composerDraft.length;
              ta.selectionStart = ta.selectionEnd = end;
              cursorPos = end;
            }
          });
          return;
        }
      }
    }
    // Esc aborts a running turn (parity with the agent TUI / Claude). Placed after the
    // slash/file/draft Esc handlers so an open menu or draft-cancel wins first.
    if (e.key === "Escape" && streaming) {
      e.preventDefault();
      abortFromComposer();
      return;
    }
    // Alt+Enter (opt+enter on macOS) inserts a newline, matching the polytoken
    // TUI behavior. Chromium doesn't insert one natively for Alt+Enter (unlike
    // Shift+Enter), so we do it explicitly at the cursor position.
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      const ta = e.currentTarget as HTMLTextAreaElement;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = store.composerDraft;
      store.composerDraft = val.slice(0, start) + "\n" + val.slice(end);
      // Restore the caret after Svelte re-renders the bound value.
      queueMicrotask(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    // On a touch device a bare Enter inserts a newline (let the textarea handle it) so a
    // multi-line prompt is typeable from a soft keyboard; send is the button or ⌘/Ctrl+Enter.
    // Desktop keeps Enter-to-send. The slash/file menus already consumed their Enter above.
    if (isTouch && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    // Enter sends — the polytoken driver routes mid-turn sends to the queue
    // (/turn/input) and idle sends to a new turn (/prompt), so there's no
    // separate steer/follow-up mode to pick.
    submit();
  }

  // Type-to-focus: a printable keystroke while nothing is focused lands in the
  // composer. We don't preventDefault, so the character itself types into the
  // now-focused textarea. Guarded so it never steals keys from approval/settings/
  // sidebar inputs.
  onMount(() => {
    function onWindowKeydown(e: KeyboardEvent) {
      // The lightbox owns the keyboard while open (Esc/←/→) — don't steal focus or
      // re-open the picker underneath it.
      if (lightboxIndex !== null) return;
      // New-session draft shortcuts also work when the textarea isn't focused yet
      // (⌘N leaves it blurred): ⌥P toggles the project picker, ⌥W the worktree chip.
      // Handle ⌥P before the pickingCwd guard so it can also close an open picker.
      if (drafting && e.altKey && e.code === "KeyP") {
        e.preventDefault();
        pickingCwd = !pickingCwd;
        return;
      }
      if (drafting && e.altKey && e.code === "KeyW") {
        e.preventDefault();
        store.toggleDraftWorktree();
        return;
      }
      // The directory picker owns the keyboard while open (arrows / Enter / Esc to
      // navigate); don't pull focus back to the textarea on a keystroke.
      if (pickingCwd) return;
      // ⌘⇧F / Ctrl+Shift+F: open the file picker for image attachments.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        openFilePicker();
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!ta) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body) {
        const tag = el.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          el.isContentEditable
        ) {
          return;
        }
      }
      ta.focus();
    }
    function onResize() {
      winH = window.innerHeight;
    }
    // Last chance to persist the draft before a reload / close / app switch.
    function onPageHide() {
      store.stashDraft();
    }
    window.addEventListener("keydown", onWindowKeydown);
    window.addEventListener("resize", onResize);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("keydown", onWindowKeydown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pagehide", onPageHide);
    };
  });
</script>

<div
  class="composer-wrap"
  class:drag-active={dragActive}
  role="group"
  aria-label="Message composer"
  aria-busy={addingImages}
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  {#if dragActive}
    <div class="drop-overlay" data-testid="image-drop-overlay">
      Drop images to attach
    </div>
  {/if}
  <div class="col">
    {#each widgets as { w, tasks } (w.key)}
      {#if tasks}
        <TaskList {tasks} />
      {:else}
        <div class="widget">
          {#each w.lines as line, i (i)}<div class="wline">{line}</div>{/each}
        </div>
      {/if}
    {/each}

    {#if addingImages}
      <div class="attachment-status info" role="status">Preparing images…</div>
    {:else if attachmentStatus}
      <div
        class="attachment-status {attachmentStatus.kind}"
        role={attachmentStatus.kind === "error" ? "alert" : "status"}
        data-testid="attachment-status"
      >
        {attachmentStatus.text}
      </div>
    {/if}

    {#if contextCue}
      <div
        class="attachment-status context-cue {contextCue.tone}"
        role="status"
        data-testid="context-cue"
      >
        Context {contextCue.pct}% full — consider <code>/compact</code> or a fresh session.
      </div>
    {/if}

    <QueueTray />

    {#if drafting && store.draft}
      <!-- New-session location controls (project · worktree). Model + effort live in
           the status row below, rebound to the draft via store.composerConfig. -->
      <div class="chips">
        <button
          class="chip"
          data-testid="draft-project-control"
          aria-haspopup="dialog"
          aria-expanded={pickingCwd}
          title={`Project: ${store.draft.cwd || "home"} — click to browse for a directory (⌥P)`}
          onclick={() => (pickingCwd = !pickingCwd)}
        >
          {cwdBase}
          <Chevron open={pickingCwd} variant="menu" size={10} />
        </button>
        <button
          class="chip toggle-chip"
          data-testid="draft-worktree-control"
          class:on={store.draft.worktree}
          aria-pressed={store.draft.worktree}
          title="Isolate this session in a jj/git worktree of the project, leaving the main tree clean (⌥W)"
          onclick={() => store.toggleDraftWorktree()}
        >
          worktree
          {#if store.draft.worktree}<span class="chip-check" aria-hidden="true">✓</span>{/if}
        </button>
      </div>
    {/if}

    <div class="box-wrap">
      {#if pickingCwd && drafting && store.draft}
        <DirPicker
          recents={recentCwds}
          current={store.draft.cwd}
          defaultCwd={store.defaultNewSessionCwd}
          onpick={(p) => {
            store.setDraftCwd(p);
            pickingCwd = false;
            ta?.focus();
          }}
          onclose={() => {
            pickingCwd = false;
            ta?.focus();
          }}
        />
      {/if}
      {#if slashOpen}
        <SlashMenu
          items={slashItems}
          selected={slashSel}
          onpick={acceptSlash}
          onhover={(i) => (slashSel = i)}
        />
      {/if}
      {#if historyOpen}
        <PromptHistoryMenu
          items={historyItems}
          selected={historySel}
          onpick={acceptHistory}
          onhover={(i) => (historySel = i)}
        />
      {/if}
      {#if atOpen}
        <AtMenu
          items={atItems}
          selected={atSel}
          reasoningLevel={modelLevel}
          ignoreOff={ignoreToggleApplies ? ignoreOff : null}
          onpick={acceptAtItem}
          onhover={(i) => (atSel = i)}
        />
      {/if}
      <div class="box" class:streaming bind:this={box} data-testid="composer-box">
        <button
          class="expand"
          class:expanded
          onclick={toggleExpand}
          aria-pressed={expanded}
          aria-label={expanded ? "Collapse composer" : "Expand composer"}
          title={expanded ? "Collapse composer (⌥⇧↓)" : "Expand composer (⌥⇧↑)"}
          tabindex="-1"
        >{expanded ? "⌄" : "⌃"}</button>
        <div class="composer-attachments" data-testid="composer-attachments">
          <!-- Hidden file input for image attachments. -->
          <input
            bind:this={fileInput}
            type="file"
            accept="image/*"
            multiple
            class="file-input-hidden"
            onchange={onFilesSelected}
            tabindex="-1"
          />
          {#if imageCount > 0}
            <button
              class="attach-tag"
              disabled={addingImages}
              onclick={openFilePicker}
              aria-label={`Add more images (${imageCount} attached)`}
              title={`${imageCount} image${imageCount > 1 ? "s" : ""} attached — add more (⌘⇧F)`}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              {imageCount}
            </button>
            {#each images as img, i (i)}
              <span class="thumb-chip">
                <button
                  class="thumb-preview"
                  onclick={() => (lightboxIndex = i)}
                  title="Preview image full screen (Enter)"
                  aria-label={`Preview attachment ${i + 1} full screen`}
                >
                  <img src="data:{img.mimeType};base64,{img.data}" alt={`Attachment ${i + 1}`} />
                </button>
                <button
                  class="thumb-remove"
                  onclick={() => removeImage(i)}
                  onkeydown={(e) => {
                    if (e.key === "Backspace" || e.key === "Delete") {
                      e.preventDefault();
                      removeImage(i);
                    }
                  }}
                  title="Remove this image (Delete)"
                  aria-label={`Remove attachment ${i + 1}`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            {/each}
          {:else}
            <IconButton disabled={addingImages} onclick={openFilePicker} title="Attach images (⌘⇧F)" aria-label="Attach images">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.2a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </IconButton>
          {/if}
        </div>
        <textarea
          bind:this={ta}
          bind:value={store.composerDraft}
          oninput={onInput}
          onkeydown={onKeydown}
          onpaste={onPaste}
          onclick={() => (cursorPos = ta?.selectionStart ?? 0)}
          onkeyup={() => (cursorPos = ta?.selectionStart ?? 0)}
          placeholder={drafting
            ? "Describe a task or ask a question…"
            : streaming
              ? "Queue a message…"
              : "Message pantoken…"}
          rows="1"
          role="combobox"
          aria-expanded={slashOpen || atOpen}
          aria-controls={atOpen ? "at-menu" : "slash-menu"}
          aria-autocomplete="list"
        ></textarea>
        <div class="actions">
          <button
            class="send"
            disabled={submitting || addingImages || ((!store.composerDraft.trim() && imageCount === 0) && (streaming || drafting))}
            onclick={() => submit()}
            aria-label={drafting ? "Create session and send" : !store.composerDraft.trim() && imageCount === 0 ? "Send empty prompt to continue" : "Send"}
            title={drafting
              ? `Create session and send first message (${isTouch ? "⌘/Ctrl+Enter" : "Enter"})`
              : !store.composerDraft.trim() && imageCount === 0
                ? `Send empty prompt to continue (${isTouch ? "⌘/Ctrl+Enter" : "Enter"})`
                : `Send (${isTouch ? "⌘/Ctrl+Enter" : "Enter"})`}
          >
            ↑
          </button>
        </div>
      </div>
    </div>

    <div class="composer-status-row" data-testid="composer-status-row">
      <div class="status-left">
        <PermissionBadge />
        <FacetBadge />
      </div>
      {#if streaming}
        <!-- A hint that Enter while the agent works queues a follow-up (the driver
             routes mid-turn sends to /turn/input). Lives inside the always-present
             status row so finishing a turn doesn't add/remove a line and jump the
             layout. Hidden on touch viewports, where there's no Enter to hint at. -->
        <div class="toolbar-hint">
          <kbd>Enter</kbd> queues a follow-up
        </div>
      {/if}
      <div class="composer-status-right" data-testid="composer-status-right">
        {#if streaming}
          <!-- Keep Stop in the always-present status row so a turn starting/finishing
               never changes the composer's height. Unlike the follow-up hint, this
               remains visible on touch viewports as the primary in-flight control. -->
          <button
            class="stop"
            onclick={() => store.abort()}
            disabled={store.connection !== "connected" || stopState === "stopping"}
            title={store.connection === "connected"
              ? stopState === "stopping"
                ? "Stop requested — waiting for Pantoken"
                : stopState === "unconfirmed"
                  ? "Retry stopping the agent (Esc)"
                  : "Stop the agent (Esc)"
              : "Can't stop while offline — the agent keeps running"}
            >{stopState === "stopping"
              ? "■ Stopping…"
              : stopState === "unconfirmed"
                ? "↻ Retry stop"
                : "■ Stop"}</button
          >
        {/if}
        <ModelPicker />
        {#if !drafting}
          <ContextMeter />
        {/if}
        {#if store.modelCatalogDiagnostic}
          <span class="model-diagnostic" title={store.modelCatalogDiagnostic.message}>
            Model picker unavailable — {store.modelCatalogDiagnostic.message}
          </span>
        {/if}
      </div>
    </div>

  </div>
</div>

{#if lightboxIndex !== null}
  <ImageLightbox
    {images}
    index={lightboxIndex}
    onClose={closeLightbox}
    onIndex={(i) => (lightboxIndex = i)}
  />
{/if}

<style>
  .composer-wrap {
    position: relative;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    padding: 10px 44px calc(12px + env(safe-area-inset-bottom));
  }
  .composer-wrap.drag-active {
    background: color-mix(in srgb, var(--accent) 10%, var(--bg));
  }
  .drop-overlay {
    position: absolute;
    inset: 6px 12px calc(8px + env(safe-area-inset-bottom));
    z-index: 20;
    display: grid;
    place-items: center;
    pointer-events: none;
    border: 2px dashed var(--accent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    color: var(--accent);
    font-size: 14px;
    font-weight: 650;
    backdrop-filter: blur(5px);
  }
  .col {
    max-width: var(--maxw);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .widget {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 11px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .wline {
    line-height: 1.5;
  }
  .attachment-status {
    border-radius: var(--radius-xs);
    padding: 6px 9px;
    font-size: 12px;
    line-height: 1.4;
  }
  .attachment-status.error {
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
  }
  .attachment-status.info {
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--text-muted);
  }
  /* Context-pressure cue. Colors mirror the meter ring's bands so the words and the
     ring agree: blue accent at 85–89%, escalating to red at 90%+. */
  .attachment-status.context-cue.accent {
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .attachment-status.context-cue.danger {
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
  }
  .attachment-status.context-cue code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: color-mix(in srgb, currentColor 12%, transparent);
    padding: 0 4px;
    border-radius: var(--radius-xs);
  }
  .stop {
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 13px;
    font-weight: 550;
    padding: 5px 14px;
    border-radius: 999px;
  }
  /* Offline: a remote turn can't be stopped from a dead socket, so the pill reads inert
     rather than inviting a dead click (the offline banner explains the agent keeps going). */
  .stop:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    font-family: var(--font-sans);
    letter-spacing: -0.01em;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    padding: 6px 8px;
    min-height: 36px;
    border-radius: var(--radius-xs);
    cursor: pointer;
    max-width: 60vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Touch: keep the small config pills reliably tappable (≥44px) on coarse pointers. */
  @media (pointer: coarse) {
    .chip {
      min-height: 44px;
    }
  }
  .chip:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .chip:hover :global(.chevron) {
    color: var(--text-muted);
  }
  .chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .chip-check {
    display: inline-grid;
    place-items: center;
    width: 12px;
    font-size: 11px;
    line-height: 1;
  }
  .box-wrap {
    /* Anchor for the slash menu, which pops upward from just above the box. */
    position: relative;
  }
  .box {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 8px 8px 8px 10px;
    transition: border-color 0.15s;
  }
  .composer-attachments {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: flex-end;
    gap: 5px;
    max-width: min(30vw, 180px);
    flex-wrap: wrap;
  }
  .box:focus-within {
    border-color: var(--accent);
  }
  /* Drag-handle-style expand toggle, straddling the top border. Greyed out at
     rest; revealed on hover (desktop) or focus-within (touch, which has no hover). */
  .expand {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 32px;
    height: 16px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-faint);
    font-size: 11px;
    line-height: 1;
    opacity: 0;
    cursor: pointer;
    z-index: 2;
    transition: opacity 0.15s, color 0.15s;
  }
  .box:hover .expand,
  .box:focus-within .expand,
  .expand.expanded {
    opacity: 1;
  }
  .expand:hover {
    color: var(--text-muted);
  }
  textarea {
    flex: 1;
    resize: none;
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    max-height: var(--composer-max, 168px);
    /* Text wraps, so horizontal scroll is never wanted; the styled h-scrollbar
       (app.css) would otherwise flicker in on subpixel overflow. Vertical only
       appears once content passes the cap. */
    overflow-x: hidden;
    overflow-y: auto;
    padding: 4px 0;
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: flex-end;
  }
  .send {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 17px;
    line-height: 1;
    display: grid;
    place-items: center;
    transition: opacity 0.15s, transform 0.1s;
  }
  .send:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .send:not(:disabled):active {
    transform: scale(0.92);
  }
  /* Steer/follow-up hint, centered in the status row between the permission and
     model/context controls. Shrinks + ellipsizes before crowding them; hidden entirely
     on touch (below). */
  .toolbar-hint {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .toolbar-hint kbd {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0 4px;
  }
  /* Touch has no Enter, and the row is tighter — drop the hint there. */
  @media (max-width: 859px) {
    .toolbar-hint {
      display: none;
    }
    .composer-wrap {
      padding-inline: 16px;
    }
    .composer-status-row {
      align-items: flex-start;
      flex-wrap: wrap;
      row-gap: 6px;
    }
    .composer-status-right {
      flex: 1 1 100%;
      justify-content: flex-end;
      flex-wrap: wrap;
      min-width: 0;
    }
    .composer-attachments {
      max-width: 42vw;
    }
  }
  .composer-status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 2px;
    min-width: 0;
  }
  .status-left,
  .composer-status-right {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .composer-status-right {
    margin-left: auto;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .model-diagnostic {
    max-width: 34ch;
    color: var(--danger);
    font-size: 11px;
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The model/effort badges can grow; let them shrink + ellipsize before the
     fixed-width context ring gives up its space. */
  .composer-status-right {
    flex-shrink: 1;
  }
  .file-input-hidden {
    position: absolute;
    width: 0;
    height: 0;
    opacity: 0;
    pointer-events: none;
  }
  .attach-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    padding: 2px 8px;
    font-size: 12px;
    font-family: var(--font-sans);
    color: var(--accent-text);
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius-xs);
    cursor: pointer;
  }
  .attach-tag:hover {
    filter: brightness(1.05);
  }
  .attach-tag:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* A thumbnail is two stacked controls: the image (click to preview full screen) and a
     small × badge pinned top-right (click to remove). The badge overhangs the chip a touch
     so it doesn't eat the previewable image area. */
  .thumb-chip {
    position: relative;
    display: inline-flex;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
  }
  .thumb-preview {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    cursor: zoom-in;
    overflow: hidden;
  }
  .thumb-preview:hover {
    border-color: var(--accent);
  }
  .thumb-preview:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .thumb-preview img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb-remove {
    position: absolute;
    top: -5px;
    right: -5px;
    display: grid;
    place-items: center;
    width: 15px;
    height: 15px;
    padding: 0;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    color: white;
    background: color-mix(in srgb, var(--danger) 88%, black 12%);
    border: 1px solid var(--bg);
    border-radius: 999px;
    cursor: pointer;
    /* Hidden until the chip is hovered/focused on desktop; always shown on touch. */
    opacity: 0;
    transition:
      opacity 0.1s,
      transform 0.1s;
  }
  .thumb-chip:hover .thumb-remove,
  .thumb-preview:focus-visible + .thumb-remove,
  .thumb-remove:focus-visible {
    opacity: 1;
  }
  .thumb-remove:hover {
    transform: scale(1.12);
  }
  .thumb-remove:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @media (pointer: coarse) {
    .status-left :global(.badge),
    .composer-status-right :global(.badge),
    .attach-tag,
    .send,
    .stop,
    .thumb-preview,
    .thumb-remove {
      min-width: 44px;
      min-height: 44px;
    }
    .thumb-chip {
      width: 44px;
      height: 44px;
    }
    .thumb-remove {
      width: 22px;
      height: 22px;
      opacity: 1;
    }
  }
</style>

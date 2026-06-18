<script lang="ts">
  import { onMount } from "svelte";
  import type { CommandInfo } from "@pilot/protocol";
  import { store } from "../lib/store.svelte.js";
  import { renderMarkdown } from "../lib/markdown.js";
  import { filterCommands, slashQuery } from "../lib/slash.js";
  import SlashMenu from "./SlashMenu.svelte";

  let deliverAs = $state<"steer" | "followUp">("steer");
  let ta = $state<HTMLTextAreaElement>();
  let box = $state<HTMLDivElement>();
  let preview = $state(false);
  // Expand toggle: collapsed keeps the composer modest so more of the session
  // shows; expanded trades that for reading a long prompt whole. Auto-resets on send.
  let expanded = $state(false);
  // Tracked so the caps re-derive on window resize (the cap scales with viewport).
  let winH = $state(window.innerHeight);

  const widgets = $derived(
    Object.values(store.session.ambient.widgets).filter((w) => w.placement === "aboveComposer"),
  );
  const streaming = $derived(store.streaming);
  // Preview only renders when there's something to show; an empty draft always
  // falls back to the editable textarea so the box never looks blank/stuck.
  const showPreview = $derived(preview && store.composerDraft.trim().length > 0);

  // --- Slash-command typeahead. The menu is open when the draft is a bare slash token
  // (slashQuery != null), the user hasn't dismissed it for this token, and there are
  // matches to show. Selection + dismissal are this component's state; the menu itself
  // is presentational. Execution is free: sending `/name args` is a normal prompt, and
  // pi's prompt() runs the command / expands the template.
  let slashSel = $state(0);
  let slashDismissed = $state(false);
  const slashQ = $derived(slashQuery(store.composerDraft));
  const slashItems = $derived(
    slashQ === null ? [] : filterCommands(store.commands, slashQ),
  );
  const slashOpen = $derived(
    slashQ !== null && !slashDismissed && slashItems.length > 0 && !showPreview,
  );
  // Keep the highlighted index in range as the filtered list shrinks under the cursor.
  $effect(() => {
    if (slashSel >= slashItems.length) slashSel = 0;
  });

  // Max textarea/preview height in px. Collapsed: floor at 3 lines so a scrollbar
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

  // Re-fit whenever the cap changes (expand toggle or window resize), in edit or
  // preview mode — autosize no-ops on the textarea when it isn't mounted.
  $effect(() => {
    maxH;
    autosize();
  });

  function submit() {
    const text = store.composerDraft;
    if (!text.trim()) return;
    store.prompt(text, streaming ? deliverAs : undefined);
    expanded = false;
    queueMicrotask(autosize);
  }

  function toggleExpand() {
    expanded = !expanded;
    queueMicrotask(() => {
      ta?.focus();
      autosize();
    });
  }

  function onInput() {
    autosize();
    // A fresh keystroke restarts the selection at the top; leaving slash mode clears a
    // prior Escape so the next `/` reopens the menu.
    slashSel = 0;
    if (slashQuery(store.composerDraft) === null) slashDismissed = false;
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

  function onKeydown(e: KeyboardEvent) {
    // Alt+Up/Down resize the composer (checked before the slash menu's bare
    // Arrow handling, which has no modifier).
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      expanded = e.key === "ArrowUp";
      queueMicrotask(autosize);
      return;
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
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    // While the agent runs, Enter steers (deliver after the current step) and
    // Alt+Enter queues a follow-up (deliver when it stops); the toggle reflects it.
    if (streaming) deliverAs = e.altKey ? "followUp" : "steer";
    submit();
  }

  function toggleEdit() {
    preview = !preview;
    // Returning to edit mode: restore focus + sizing on the textarea.
    if (!preview) queueMicrotask(() => { ta?.focus(); autosize(); });
  }

  // Type-to-focus: a printable keystroke while nothing is focused lands in the
  // composer. We don't preventDefault, so the character itself types into the
  // now-focused textarea. Guarded so it never steals keys from approval/settings/
  // sidebar inputs or while previewing.
  onMount(() => {
    function onWindowKeydown(e: KeyboardEvent) {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!ta || showPreview) return;
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
    window.addEventListener("keydown", onWindowKeydown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onWindowKeydown);
      window.removeEventListener("resize", onResize);
    };
  });
</script>

<div class="composer-wrap">
  <div class="col">
    {#each widgets as w (w.key)}
      <div class="widget">
        {#each w.lines as line, i (i)}<div class="wline">{line}</div>{/each}
      </div>
    {/each}

    {#if streaming}
      <div class="streamrow">
        <div class="modes">
          <button class:active={deliverAs === "steer"} onclick={() => (deliverAs = "steer")} title="Steer — deliver after the current step (Enter)">steer</button>
          <button class:active={deliverAs === "followUp"} onclick={() => (deliverAs = "followUp")} title="Follow-up — deliver when the agent stops (Alt+Enter)">follow-up</button>
        </div>
        <button class="stop" onclick={() => store.abort()} title="Stop the agent">■ Stop</button>
      </div>
    {/if}

    <div class="box-wrap">
      {#if slashOpen}
        <SlashMenu
          items={slashItems}
          selected={slashSel}
          onpick={acceptSlash}
          onhover={(i) => (slashSel = i)}
        />
      {/if}
      <div class="box" class:streaming bind:this={box}>
      <button
        class="expand"
        class:expanded
        onclick={toggleExpand}
        aria-pressed={expanded}
        aria-label={expanded ? "Collapse composer" : "Expand composer"}
        title={expanded ? "Collapse composer (⌥↓)" : "Expand composer (⌥↑)"}
        tabindex="-1"
      >{expanded ? "⌄" : "⌃"}</button>
      {#if showPreview}
        <div class="prose preview">{@html renderMarkdown(store.composerDraft)}</div>
      {:else}
        <textarea
          bind:this={ta}
          bind:value={store.composerDraft}
          oninput={onInput}
          onkeydown={onKeydown}
          placeholder={streaming ? "Queue a message…" : "Message pilot…"}
          rows="1"
          role="combobox"
          aria-expanded={slashOpen}
          aria-controls="slash-menu"
          aria-autocomplete="list"
        ></textarea>
      {/if}
      <div class="actions">
        {#if store.composerDraft.trim()}
          <button
            class="toggle"
            class:active={showPreview}
            onclick={toggleEdit}
            aria-pressed={showPreview}
            title={showPreview ? "Back to editing" : "Preview formatting"}
          >
            {showPreview ? "Edit" : "Preview"}
          </button>
        {/if}
        <button class="send" disabled={!store.composerDraft.trim()} onclick={submit} aria-label="Send" title="Send (Enter)">
          ↑
        </button>
      </div>
      </div>
    </div>
    {#if streaming}
      <div class="hint">
        <kbd>Enter</kbd> steers · <kbd>Alt</kbd>+<kbd>Enter</kbd> queues a follow-up
      </div>
    {/if}
  </div>
</div>

<style>
  .composer-wrap {
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(8px);
    padding: 10px 16px calc(12px + env(safe-area-inset-bottom));
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
  .streamrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .modes {
    display: inline-flex;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px;
  }
  .modes button {
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 12px;
    padding: 3px 11px;
    border-radius: 999px;
  }
  .modes button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-card);
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
    padding: 8px 8px 8px 14px;
    transition: border-color 0.15s;
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
  .preview {
    flex: 1;
    min-width: 0;
    max-height: var(--composer-max, 168px);
    overflow-y: auto;
    padding: 4px 0;
    font-size: 16px;
    line-height: 1.5;
    color: var(--text);
    word-break: break-word;
  }
  /* Scoped prose styling for the live preview (the .prose :global rules live in
     Transcript.svelte and don't reach this component). */
  .prose :global(p) {
    margin: 0 0 10px;
  }
  .prose :global(p:last-child) {
    margin-bottom: 0;
  }
  .prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.88em;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: var(--radius-xs);
  }
  .prose :global(pre) {
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    overflow-x: auto;
    margin: 10px 0;
  }
  .prose :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.86em;
    line-height: 1.55;
  }
  .prose :global(a) {
    color: var(--accent);
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    align-self: flex-end;
  }
  .toggle {
    border: 1px solid var(--border);
    background: var(--surface-sunken);
    color: var(--text-muted);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 999px;
    transition: color 0.15s, border-color 0.15s;
  }
  .toggle.active {
    color: var(--accent-text);
    background: var(--accent);
    border-color: var(--accent);
  }
  .send {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
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
  .hint {
    font-size: 11.5px;
    color: var(--text-faint);
    text-align: center;
    padding: 0 2px;
  }
  .hint kbd {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0 4px;
  }
</style>

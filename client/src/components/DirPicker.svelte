<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import {
    completeDirectoryInput,
    rankDirectoryMatches,
    splitDirectoryInput,
  } from "../lib/directory-picker.js";
  import { overlayHistory } from "../lib/overlay-history.js";
  import { store } from "../lib/store.svelte.js";
  import { scrollIndexIntoView } from "../lib/scroll-into-view.js";

  let {
    current,
    defaultCwd,
    onpick,
    onclose,
  }: {
    current: string;
    defaultCwd: string;
    onpick: (path: string) => void;
    onclose: () => void;
  } = $props();

  let inputRef = $state<HTMLInputElement>();
  let dialogRef = $state<HTMLDivElement>();
  let pathText = $state(
    untrack(() => `${(current.trim() || defaultCwd).replace(/\/+$/, "")}/`),
  );
  let selected = $state(0);
  let handledClose = false;
  const pathParts = $derived(splitDirectoryInput(pathText));
  const showing = $derived(store.dirListing);
  const matches = $derived(rankDirectoryMatches(showing?.entries ?? [], pathParts.leaf));
  const canUse = $derived(
    pathParts.viewingDirectory && !!showing && !showing.error && !store.dirLoading,
  );
  const optionCount = $derived(matches.length + (canUse ? 1 : 0));
  const matchOffset = $derived(canUse ? 1 : 0);

  $effect(() => {
    pathText;
    selected = 0;
  });

  $effect(() => {
    if (optionCount === 0) selected = 0;
    else if (selected >= optionCount) selected = optionCount - 1;
  });

  let queryTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const text = pathText;
    const browsePath = pathParts.browsePath;
    // The previous listing belongs to a different editable path. Hide it immediately;
    // otherwise a fast second Enter could choose the old directory during debounce.
    store.invalidateDirPickerQueries();
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      store.queryDir(browsePath);
      if (text.trim()) store.statPath(text);
    }, 90);
    return () => clearTimeout(queryTimer);
  });

  onMount(() => {
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.setSelectionRange(pathText.length, pathText.length);
    });
    overlayHistory.opened("directory-picker", () => {
      handledClose = true;
      onclose();
    });
  });

  onDestroy(() => {
    if (!handledClose) overlayHistory.closed("directory-picker");
  });

  function closeFromUi(): void {
    handledClose = true;
    overlayHistory.closed("directory-picker");
    onclose();
  }

  function useCurrent(): void {
    if (!canUse || !showing) return;
    handledClose = true;
    overlayHistory.closed("directory-picker");
    onpick(showing.path);
  }

  function complete(name: string): void {
    pathText = completeDirectoryInput(pathText, name);
    selected = 0;
    requestAnimationFrame(() => {
      inputRef?.focus();
      inputRef?.setSelectionRange(pathText.length, pathText.length);
    });
  }

  function activateSelected(): void {
    if (canUse && selected === 0) {
      useCurrent();
      return;
    }
    const match = matches[selected - matchOffset];
    if (match) complete(match.name);
  }

  function move(delta: number): void {
    if (optionCount) selected = (selected + delta + optionCount) % optionCount;
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFromUi();
      return;
    }
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateSelected();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      const match = matches[selected - matchOffset];
      if (match) complete(match.name);
      return;
    }
    if (
      event.key === "ArrowRight" &&
      inputRef?.selectionStart === pathText.length &&
      inputRef.selectionEnd === pathText.length
    ) {
      const match = matches[selected - matchOffset];
      if (match) {
        event.preventDefault();
        complete(match.name);
      }
    }
    // Backspace (including Option+Backspace), editing shortcuts, and left-arrow movement
    // deliberately remain native input behavior.
  }

  function onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFromUi();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      ) ?? []),
    ].filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const pathState = $derived.by(() => {
    if (!pathText.trim() || store.dirLoading) return null;
    const stat = store.pathStat;
    if (!stat) return null;
    if (stat.exists && !stat.isDir) return "That path is not a directory.";
    if (!stat.exists && !matches.length && !pathParts.viewingDirectory) {
      return "No matching directory.";
    }
    return null;
  });
</script>

<div
  class="scrim"
  data-testid="dir-picker-scrim"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) closeFromUi();
  }}
>
  <div
    class="picker"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dir-picker-title"
    data-testid="dir-picker"
    tabindex="-1"
    bind:this={dialogRef}
    onkeydown={onDialogKeydown}
  >
    <header>
      <button class="back" aria-label="Close project picker" title="Close project picker (Esc)" onclick={closeFromUi}>
        <span aria-hidden="true">‹</span><span>Back</span>
      </button>
      <div class="picker-heading">
        <h2 id="dir-picker-title">Choose project directory</h2>
        <div class="server" data-testid="dir-picker-server">
          <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="5" rx="1.5"/><rect x="3" y="12" width="14" height="5" rx="1.5"/><path d="M6 5.5h.01M6 14.5h.01"/></svg>
          <span>{store.serverLabel}</span>
        </div>
      </div>
      <button class="close" aria-label="Close project picker" title="Close project picker (Esc)" onclick={closeFromUi}>×</button>
    </header>

    <div class="path-row">
      <input
        bind:this={inputRef}
        bind:value={pathText}
        class="path-input"
        aria-label="Project directory path"
        aria-controls="directory-results"
        aria-activedescendant={optionCount ? `dir-option-${selected}` : undefined}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        onkeydown={onInputKeydown}
      />
    </div>

    <div
      id="directory-results"
      class="results"
      role="listbox"
      aria-label="Directory suggestions"
      use:scrollIndexIntoView={selected}
    >
      {#if canUse}
        <button
          id="dir-option-0"
          class="result use"
          class:selected={selected === 0}
          data-i="0"
          data-testid="use-current-directory"
          role="option"
          aria-selected={selected === 0}
          title={`Use ${showing?.path ?? pathText} as the project directory (Enter)`}
          onmouseenter={() => (selected = 0)}
          onclick={useCurrent}
        >
          <span class="arrow" aria-hidden="true">↗</span>
          <span>Use this directory</span>
        </button>
      {/if}

      {#each matches as match, index (match.name)}
        {@const optionIndex = index + matchOffset}
        <button
          id={`dir-option-${optionIndex}`}
          class="result directory"
          class:selected={selected === optionIndex}
          data-i={optionIndex}
          role="option"
          aria-selected={selected === optionIndex}
          title={`Open ${match.name}/ (Enter or Tab)`}
          onmouseenter={() => (selected = optionIndex)}
          onclick={() => complete(match.name)}
        >
          <svg class="folder" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.75 6.25A2.25 2.25 0 0 1 5 4h3l1.5 1.75H15A2.25 2.25 0 0 1 17.25 8v6A2.25 2.25 0 0 1 15 16.25H5A2.25 2.25 0 0 1 2.75 14z"/></svg>
          <span class="name">{match.name}</span>
        </button>
      {/each}

      {#if store.dirLoading}
        <div class="message" role="status">Loading directories…</div>
      {:else if showing?.error}
        <div class="message error" role="alert">This directory can’t be read. Check the path or its permissions.</div>
      {:else if pathState}
        <div class="message error" role="status">{pathState}</div>
      {:else if !optionCount}
        <div class="message">No matching directories.</div>
      {/if}
    </div>

    <footer aria-hidden="true">
      <span><kbd>↑↓</kbd> select</span>
      <span><kbd>Enter</kbd> open or choose</span>
      <span><kbd>Tab</kbd> complete</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 120;
    display: grid;
    place-items: center;
    padding: 24px;
    background: color-mix(in srgb, var(--backdrop, #111) 52%, transparent);
  }
  .picker {
    width: min(640px, calc(100vw - 48px));
    max-height: min(620px, calc(100dvh - 48px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg, 14px);
    box-shadow: var(--shadow-card);
  }
  header {
    display: grid;
    grid-template-columns: 44px 1fr 44px;
    align-items: start;
    border-bottom: 1px solid var(--border);
  }
  .picker-heading {
    grid-column: 2;
    min-width: 0;
    padding: 15px 8px 13px;
  }
  h2 {
    margin: 0 0 7px;
    font-size: 15px;
    font-weight: 600;
    text-align: center;
  }
  .server {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  .server svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .server span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .back,
  .close {
    min-width: 44px;
    min-height: 44px;
    color: var(--text-muted);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .back {
    grid-column: 1;
    display: none;
  }
  .close {
    grid-column: 3;
    font-size: 22px;
  }
  .back:hover,
  .close:hover {
    color: var(--text);
  }
  .back:focus-visible,
  .close:focus-visible,
  .result:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .path-row {
    padding: 11px 12px;
    border-bottom: 1px solid var(--border);
  }
  .path-input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    color: var(--text);
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    outline: none;
    font: 13.5px/1.4 var(--font-mono);
  }
  .path-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .results {
    min-height: 96px;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 5px;
  }
  .result {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 40px;
    padding: 7px 10px;
    text-align: left;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .result.selected {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .folder {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.5;
  }
  .arrow {
    width: 18px;
    color: var(--text-muted);
    text-align: center;
    font-size: 17px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 13.5px;
  }
  .message {
    padding: 18px 12px;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .message.error {
    color: var(--danger);
  }
  footer {
    display: flex;
    gap: 16px;
    padding: 8px 12px;
    color: var(--text-faint);
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
  kbd {
    font: inherit;
    color: var(--text-muted);
  }

  @media (max-width: 859px) {
    .scrim {
      display: block;
      padding: 0;
      background: var(--surface);
    }
    .picker {
      width: 100vw;
      height: 100dvh;
      max-height: none;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      padding-bottom: env(safe-area-inset-bottom);
    }
    header {
      padding-top: env(safe-area-inset-top);
      align-items: center;
    }
    .picker-heading {
      padding: 8px 4px 7px;
    }
    h2 {
      margin-bottom: 2px;
      font-size: 14px;
    }
    .server {
      font-size: 11.5px;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 0 8px;
      font-size: 13px;
    }
    .back span:first-child {
      font-size: 25px;
      line-height: 1;
    }
    .close {
      visibility: hidden;
    }
    .path-row {
      padding: 10px 8px;
    }
    .path-input {
      min-height: 44px;
      font-size: 16px;
    }
    .results {
      padding: 4px;
    }
    .result {
      min-height: 48px;
      padding-inline: 12px;
    }
    footer {
      display: none;
    }
  }
</style>

<script lang="ts">
  import { onDestroy } from "svelte";
  import { reveal } from "../lib/transitions.js";
  import type { ToolItem } from "@pantoken/protocol";
  import Chevron from "./ui/Chevron.svelte";
  import { imageViewer } from "../lib/image-viewer.svelte.js";
  import { store } from "../lib/store.svelte.js";

  // `flat` drops the card chrome (border/background/rounded box) so the call renders as a
  // bare row. Currently unused (the merge layer that passed flat=true was removed), but
  // kept for future use — the CSS is still wired. Standalone cards keep flat=false.
  let { item, flat = false }: { item: ToolItem; flat?: boolean } = $props();
  let open = $state(false);

  // Output controls: the result <pre> is capped at 320px (see .out below), which turns a
  // long log into a nested scroll-trap on touch. Offer a copy + an inline expand that drops
  // the cap. The expand affordance only shows when the collapsed output actually overflows.
  let outExpanded = $state(false);
  let outOverflows = $state(false);
  let outPre = $state<HTMLElement>();
  type CopyTarget = "arguments" | "stream" | "output";
  let copied = $state<CopyTarget | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  // Copies via store.copyToClipboard so a rejection (permissions / insecure
  // context) surfaces as a visible error instead of a silent no-op.
  async function copyDetail(target: CopyTarget, text: string) {
    if (!(await store.copyToClipboard(text))) return;
    copied = target;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = null), 1500);
  }

  // Measure overflow while collapsed (scrollHeight exceeds the capped clientHeight). Keep
  // the toggle once expanded so it can always be collapsed back; re-measures when the
  // output text changes (e.g. a streamed result settling). Overflow is width-dependent
  // (the text wraps), so a ResizeObserver re-measures on rotation/resize too — otherwise
  // the affordance goes stale. The callback never reads outOverflows, so there's no loop.
  $effect(() => {
    void outBodyText;
    const el = outPre;
    if (!el) return;
    const measure = () => {
      if (!outExpanded) outOverflows = el.scrollHeight > el.clientHeight + 1;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // A pending "Copied" flash could outlive the card (transcript re-render / session switch
  // within 1.5s); clear it on teardown so the timer never fires into a destroyed instance.
  onDestroy(() => clearTimeout(copyTimer));

  const HEADER_PREVIEW_LIMIT = 320;
  const DETAIL_VALUE_LIMIT = 20_000;
  const OUTPUT_LIMIT = 50_000;
  const ARG_LIMIT = 40;
  // Keep the rich diff renderer's Shadow DOM proportional even when an edit contains
  // a generated file or minified line. Both dimensions matter: a character-only cap
  // can still create thousands of DOM rows, while a line-only cap can admit one huge
  // highlighted line. Exact source values remain available through the copy actions.
  const EDIT_PREVIEW_CHAR_LIMIT = 20_000;
  const EDIT_PREVIEW_LINE_LIMIT = 160;
  const EDIT_COUNT_WORK_LIMIT = 500_000;

  function bound(text: string, limit: number): string {
    return text.length <= limit
      ? text
      : `${text.slice(0, limit)}\n… output truncated by pantoken`;
  }

  function inlineBound(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
  }

  function stringify(value: unknown, pretty = false): string {
    try {
      return JSON.stringify(value, null, pretty ? 2 : undefined) ?? "";
    } catch {
      return "[unserializable value]";
    }
  }

  function rawInputText(input: unknown): string {
    return stringify(input, true);
  }

  function preview(input: unknown): string {
    if (input == null) return "";
    let text: string;
    if (typeof input === "object") {
      const o = input as Record<string, unknown>;
      if (typeof o.command === "string") text = o.command;
      else if (typeof o.path === "string") text = o.path;
      else if (typeof o.file_path === "string") text = o.file_path;
      else text = stringify(input);
    } else {
      text = String(input);
    }
    return inlineBound(text, HEADER_PREVIEW_LIMIT);
  }

  // Detailed argument view for the expanded body. The collapsed header only shows a
  // short single-line preview() (e.g. the start of a bash command); here we render a
  // bounded set of individually bounded values. String values stay raw so multi-line
  // commands keep their newlines instead of becoming JSON-escaped "\n".
  function argEntries(input: unknown): { key: string; value: string }[] {
    if (input == null) return [];
    if (typeof input !== "object")
      return [{ key: "", value: bound(String(input), DETAIL_VALUE_LIMIT) }];
    const entries = Object.entries(input as Record<string, unknown>);
    const rows = entries.slice(0, ARG_LIMIT).map(([key, v]) => ({
      key,
      value: bound(
        typeof v === "string" ? v : stringify(v, true),
        DETAIL_VALUE_LIMIT,
      ),
    }));
    if (entries.length > ARG_LIMIT) {
      rows.push({
        key: "",
        value: `… ${entries.length - ARG_LIMIT} more arguments omitted`,
      });
    }
    return rows;
  }

  // Live tool results arrive as the daemon's raw object { content: [{type:"text",text}|{type:"image",data,mimeType}], details? },
  // while replayed-from-history results are already plain text. Pull the text blocks
  // out so a tool card renders the SAME before and after a reload. '' when there are
  // none (or the shape isn't the daemon's content array).
  function contentText(out: unknown, limit?: number): string {
    if (out && typeof out === "object") {
      const content = (out as { content?: unknown }).content;
      if (Array.isArray(content)) {
        let text = "";
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            typeof (block as { text?: unknown }).text === "string"
          ) {
            text += (block as { text: string }).text;
            if (limit !== undefined && text.length > limit)
              return bound(text, limit);
          }
        }
        return text;
      }
    }
    return "";
  }

  function rawOutputText(out: unknown): string {
    if (out == null) return "";
    if (typeof out === "string") return out;
    const text = contentText(out);
    if (text) return text;
    return stringify(out, true);
  }

  function rawValueText(value: unknown): string {
    if (value == null) return "";
    return typeof value === "string" ? value : stringify(value, true);
  }

  function outputText(out: unknown): string {
    if (out == null) return "";
    if (typeof out === "string") return bound(out, OUTPUT_LIMIT);
    const text = contentText(out, OUTPUT_LIMIT);
    if (text) return text;
    return bound(stringify(out, true), OUTPUT_LIMIT);
  }

  // Images the tool returned, lifted into a typed field by the driver (event-map on the
  // live path, history-map on reload) — so the SAME data renders before and after a
  // reconnect, with no sniffing of the raw result shape.
  const outImages = $derived(item.images ?? []);
  // Body text for the result. With images present, show ONLY the accompanying text note
  // (a live object → its text blocks, a replayed string → itself) — never a JSON dump.
  // This derived display value is bounded while rawOutputText remains available lazily to
  // the explicit Copy action, so a huge result does not enter the DOM or get lost.
  const outBodyText = $derived.by(() => {
    if (item.output === undefined) return "";
    if (outImages.length)
      return typeof item.output === "string"
        ? bound(item.output, OUTPUT_LIMIT)
        : contentText(item.output, OUTPUT_LIMIT);
    return outputText(item.output);
  });
  const streamBodyText = $derived(bound(item.text ?? "", OUTPUT_LIMIT));

  const statusLabel: Record<ToolItem["status"], string> = {
    running: "running",
    ok: "completed",
    error: "failed",
    interrupted: "interrupted",
  };

  // Elapsed wall-clock for the call, derived from the toolStarted→toolFinished
  // timestamps the fold reducer stamps. Timestamps are ISO strings OR epoch-ms strings
  // (the mock uses a numeric counter); Number() handles the latter, Date.parse the
  // former. Null when either bound is missing (still running, or replayed history that
  // lacked a timestamp) — the badge hides rather than show a bogus 0ms.
  function parseTs(s: string | undefined): number | null {
    if (!s) return null;
    const n = Number(s);
    const ms = Number.isNaN(n) ? Date.parse(s) : n;
    return Number.isNaN(ms) ? null : ms;
  }
  const durationMs = $derived.by(() => {
    const a = parseTs(item.startedAt);
    const b = parseTs(item.finishedAt);
    if (a === null || b === null) return null;
    const d = b - a;
    return d >= 0 ? d : null;
  });
  /** "340ms" under a second, else "1.2s" (one decimal); minutes for the rare long run. */
  function fmtDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return `${m}m ${rem}s`;
  }
  const durationLabel = $derived(durationMs === null ? null : fmtDuration(durationMs));

  // ── Edit-tool diff support ────────────────────────────────────────────────
  // Detect the agent's edit tool by SHAPE, not name: input is an object with a `path`
  // (string) plus either `edits: [{oldText,newText}]` or legacy top-level
  // oldText/newText strings. `file_path` is an accepted alias for `path` in the agent.
  type Edit = { oldText: string; newText: string };

  function editFrom(input: unknown): { path: string; edits: Edit[] } | null {
    if (!input || typeof input !== "object") return null;
    const o = input as Record<string, unknown>;
    const path =
      typeof o.path === "string"
        ? o.path
        : typeof o.file_path === "string"
          ? o.file_path
          : null;
    if (!path) return null;
    if (
      Array.isArray(o.edits) &&
      o.edits.length > 0 &&
      o.edits.every(
        (e) =>
          e &&
          typeof e === "object" &&
          typeof (e as Edit).oldText === "string" &&
          typeof (e as Edit).newText === "string",
      )
    ) {
      return { path, edits: o.edits as Edit[] };
    }
    if (typeof o.oldText === "string" && typeof o.newText === "string") {
      return { path, edits: [{ oldText: o.oldText, newText: o.newText }] };
    }
    return null;
  }

  const edit = $derived(editFrom(item.input));
  // Edit tools visualize their input as a diff below, so the raw arg dump would
  // duplicate it — only build arg rows for non-edit tools.
  const argRows = $derived(edit ? [] : argEntries(item.input));

  type BoundedEditText = { text: string; truncated: boolean };

  function boundEditText(text: string): BoundedEditText {
    let end = Math.min(text.length, EDIT_PREVIEW_CHAR_LIMIT);
    let lines = 1;
    for (let i = 0; i < end; i++) {
      if (text[i] === "\n" && ++lines > EDIT_PREVIEW_LINE_LIMIT) {
        end = i;
        break;
      }
    }
    return { text: text.slice(0, end), truncated: end < text.length };
  }

  // Build one bounded joined side without first allocating the full concatenation.
  // That matters when a tool supplies many individually large edits: the protocol
  // already owns the raw strings, so visualization should allocate only its cap.
  function joinSideBounded(edits: Edit[], side: keyof Edit): BoundedEditText {
    const parts: string[] = [];
    let chars = 0;
    let lines = 1;
    let truncated = false;

    const append = (value: string) => {
      let end = Math.min(value.length, EDIT_PREVIEW_CHAR_LIMIT - chars);
      for (let i = 0; i < end; i++) {
        if (value[i] === "\n" && ++lines > EDIT_PREVIEW_LINE_LIMIT) {
          end = i;
          break;
        }
      }
      if (end > 0) {
        parts.push(value.slice(0, end));
        chars += end;
      }
      if (end < value.length) truncated = true;
    };

    for (let i = 0; i < edits.length; i++) {
      if (truncated) break;
      if (i > 0) append("\n");
      if (!truncated) append(edits[i]?.[side] ?? "");
    }
    return { text: parts.join(""), truncated };
  }

  // An agent edit result may carry a richer standard unified patch in details.patch —
  // prefer it when present, otherwise the input-derived oldFile/newFile is truth.
  function patchFrom(out: unknown): string | null {
    if (!out || typeof out !== "object") return null;
    const details = (out as { details?: unknown }).details;
    if (details && typeof details === "object") {
      const p = (details as { patch?: unknown }).patch;
      if (typeof p === "string" && p.trim().length > 0) return p;
    }
    return null;
  }


  // This is the sole payload allowed across the async @pierre/diffs boundary. A
  // truncated rich patch falls back to the independently bounded old/new sides:
  // feeding an incomplete unified patch to the parser is unreliable, and the input
  // sides still produce an honest bounded preview. Ordinary patches remain untouched.
  const diffPreview = $derived.by(() => {
    if (!edit) return null;
    const oldFile = joinSideBounded(edit.edits, "oldText");
    const newFile = joinSideBounded(edit.edits, "newText");
    const rawPatch = patchFrom(item.output);
    const patch = rawPatch ? boundEditText(rawPatch) : null;
    const selectedPatch = patch && !patch.truncated ? patch.text : null;
    return {
      path: inlineBound(edit.path, HEADER_PREVIEW_LIMIT),
      oldFile: oldFile.text,
      newFile: newFile.text,
      patch: selectedPatch,
      // Report truncation only for the branch the user actually sees. A complete
      // rich patch does not become partial merely because its unused input sides
      // exceed the side-preview cap.
      truncated: selectedPatch ? false : oldFile.truncated || newFile.truncated,
    };
  });

  type ExactLineCounts = { added: number; removed: number; work: number };

  function lineCount(text: string): number {
    if (!text.length) return 0;
    let count = 1;
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") count++;
    return count;
  }

  // Exact LCS line counts with O(min(oldLines,newLines)) auxiliary memory. The
  // caller supplies the remaining comparison-work budget, keeping quadratic CPU
  // off the UI thread for edits whose line matrix is too large.
  function lineCounts(
    oldText: string,
    newText: string,
    workBudget: number,
  ): ExactLineCounts | null {
    const oldLines = lineCount(oldText);
    const newLines = lineCount(newText);
    const work = oldLines * newLines;
    if (work > workBudget) return null;
    const a = oldText.length ? oldText.split("\n") : [];
    const b = newText.length ? newText.split("\n") : [];
    const rows = a.length >= b.length ? a : b;
    const columns = a.length >= b.length ? b : a;
    let previous = new Uint32Array(columns.length + 1);
    let current = new Uint32Array(columns.length + 1);
    for (const row of rows) {
      for (let j = 1; j <= columns.length; j++) {
        current[j] =
          row === columns[j - 1]
            ? (previous[j - 1] ?? 0) + 1
            : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
      }
      [previous, current] = [current, previous];
      current.fill(0);
    }
    const common = previous[columns.length] ?? 0;
    return {
      added: b.length - common,
      removed: a.length - common,
      work,
    };
  }

  const counts = $derived.by(() => {
    if (!edit) return null;
    let added = 0;
    let removed = 0;
    let workRemaining = EDIT_COUNT_WORK_LIMIT;
    for (const e of edit.edits) {
      const count = lineCounts(e.oldText, e.newText, workRemaining);
      if (!count) return { kind: "omitted" } as const;
      added += count.added;
      removed += count.removed;
      workRemaining -= count.work;
    }
    return { kind: "exact", added, removed } as const;
  });

  // ── Theme: the app resolves to a CONCRETE data-theme ("light"|"dark") on <html>.
  // The pierre diff HTML uses light-dark(); force it to the app's concrete theme
  // via themeType so it always matches, and re-render when the user toggles.
  function currentTheme(): "light" | "dark" {
    if (typeof document === "undefined") return "light";
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }
  let theme = $state<"light" | "dark">(currentTheme());

  $effect(() => {
    const html = document.documentElement;
    const obs = new MutationObserver(() => {
      const t = currentTheme();
      if (t !== theme) theme = t;
    });
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  });

  // Cache the rendered HTML per theme so re-expanding (or re-rendering for any
  // other reason) doesn't recompute the heavy shiki render. Keyed by theme +
  // the diff inputs so a different edit/patch invalidates correctly.
  const diffCache = new Map<string, Promise<string>>();

  function diffHTML(theme: "light" | "dark"): Promise<string> | null {
    if (!diffPreview) return null;
    const key = `${theme}::${JSON.stringify(diffPreview)}`;
    const cached = diffCache.get(key);
    if (cached) return cached;
    const p = renderDiff(theme, diffPreview);
    // Evict on failure so a transient first-load error (e.g. a theme chunk that
    // briefly failed to resolve) can retry on the next expand instead of being
    // pinned to the rejected promise.
    p.catch(() => diffCache.delete(key));
    diffCache.set(key, p);
    return p;
  }

  async function renderDiff(
    theme: "light" | "dark",
    preview: NonNullable<typeof diffPreview>,
  ): Promise<string> {
    // Dynamic import keeps shiki + the diff machinery out of the initial PWA
    // bundle; only loaded the first time a diff is actually shown. Must use the
    // React-free "/ssr" entry — "." doesn't expose preloadDiffHTML and "/react"
    // pulls in react/react-dom.
    const ssr = await import("@pierre/diffs/ssr");
    const themeOpt = { dark: "github-dark", light: "github-light" } as const;
    if (preview.patch) {
      const res = await ssr.preloadPatchDiff({
        patch: preview.patch,
        options: { theme: themeOpt, themeType: theme, diffStyle: "unified" },
      });
      return res.prerenderedHTML;
    }
    return ssr.preloadDiffHTML({
      oldFile: { name: preview.path, contents: preview.oldFile },
      newFile: { name: preview.path, contents: preview.newFile },
      options: { theme: themeOpt, themeType: theme, diffStyle: "unified" },
    });
  }

  // The pierre HTML is Shadow-DOM-shaped (:host{} + <slot> + light-dark()), so it
  // only takes effect inside a shadow root. Mount it via a Svelte attachment that
  // owns a single shadow root and swaps innerHTML. Returned as an Attachment
  // (`(node) => void`); re-runs when `html` changes (attachShadow is guarded so a
  // re-run reuses the existing root). All CSS the diff needs is inlined in the
  // string — nothing else to inject.
  function mountDiff(html: string) {
    return (node: HTMLElement) => {
      const root = node.shadowRoot ?? node.attachShadow({ mode: "open" });
      root.innerHTML = html;
    };
  }
</script>

<div class="tool {item.status}" class:flat class:open>
  <button
    class="head"
    title={open ? "Collapse tool details" : "Expand tool details"}
    onclick={() => (open = !open)}
    aria-expanded={open}
  >
    <span class="status-accessible">{statusLabel[item.status]}. </span>
    {#if item.status === "running"}
      <span class="status" aria-hidden="true">○</span>
    {:else if item.status === "error"}
      <span class="status" aria-hidden="true">✕</span>
    {/if}
    <span class="name" title={item.description || undefined}>{item.label ?? item.name}</span>
    <span class="arg">{preview(item.input)}</span>
    {#if item.status === "interrupted"}
      <span class="status-text" aria-hidden="true">interrupted</span>
    {/if}
    {#if counts?.kind === "exact"}
      <span class="counts" aria-label="{counts.added} added, {counts.removed} removed">
        <span class="add">+{counts.added}</span>
        <span class="del">−{counts.removed}</span>
      </span>
    {:else if counts?.kind === "omitted"}
      <span
        class="counts-omitted"
        title="Line counts omitted for large edit"
        aria-label="Line counts omitted for large edit">large edit</span
      >
    {/if}
    {#if durationLabel}
      <span class="duration" title={`Took ${durationLabel}`} aria-label={`took ${durationLabel}`}>{durationLabel}</span>
    {/if}
    <Chevron {open} size={10} />
  </button>
  {#if outImages.length}
    <!-- A tool's image output (a screenshot, a rendered mockup, an image read) is a
         visual artifact the user is meant to SEE, so it renders here — always visible,
         OUTSIDE the collapsible body — instead of hiding behind the expand toggle. The
         card chrome (args, text note, duration) stays tucked away under the header. -->
    <div class="out-images">
      {#each outImages as img, i (i)}
        <button
          type="button"
          class="out-img-btn"
          onclick={() => imageViewer.open(outImages, i)}
          title="View image full screen (Enter)"
          aria-label={`View tool image output ${i + 1} full screen`}
        >
          <img
            class="out-img"
            src={`data:${img.mimeType};base64,${img.data}`}
            alt={`Tool image output ${i + 1}`}
          />
        </button>
      {/each}
    </div>
  {/if}
  {#if open}
    <div class="body" transition:reveal>
      {#if argRows.length}
        <div class="args-block">
          <div class="detail-bar">
            <button
              type="button"
              class="out-action"
              title="Copy this tool's full arguments to the clipboard"
              onclick={() => copyDetail("arguments", rawInputText(item.input))}
              >{copied === "arguments" ? "Copied" : "Copy full arguments"}</button
            >
          </div>
          <div class="args">
            {#each argRows as row}
              {#if row.key}<div class="arg-key">{row.key}</div>{/if}
              <pre class="arg-val">{row.value}</pre>
            {/each}
          </div>
        </div>
      {/if}
      {#if streamBodyText}
        <div class="stream-block">
          <div class="detail-bar">
            <button
              type="button"
              class="out-action"
              title="Copy this tool's full progress text to the clipboard"
              onclick={() => copyDetail("stream", item.text ?? "")}
              >{copied === "stream" ? "Copied" : "Copy full progress"}</button
            >
          </div>
          <pre class="stream">{streamBodyText}</pre>
        </div>
      {/if}
      {#if edit}
        <div class="detail-bar edit-detail-bar">
          <button
            type="button"
            class="out-action"
            title="Copy this edit's full raw arguments to the clipboard"
            onclick={() => copyDetail("arguments", rawInputText(item.input))}
            >{copied === "arguments" ? "Copied" : "Copy full arguments"}</button
          >
          {#if item.output !== undefined}
            <button
              type="button"
              class="out-action"
              title="Copy this edit's full raw result to the clipboard"
              onclick={() => copyDetail("output", rawValueText(item.output))}
              >{copied === "output" ? "Copied" : "Copy full result"}</button
            >
          {/if}
        </div>
        {#if diffPreview?.truncated}
          <div class="diff-note">Preview truncated · copy the full arguments or result above</div>
        {/if}
        {#await diffHTML(theme)}
          <div class="diff-pending">rendering diff…</div>
        {:then html}
          {#if html}
            <div class="diff" {@attach mountDiff(html)}></div>
          {/if}
        {:catch err}
          <div class="diff-error">couldn't render diff: {err?.message ?? String(err)}</div>
          {#if item.output !== undefined}<pre class="out">{outputText(item.output)}</pre>{/if}
        {/await}
      {:else if item.output !== undefined}
        {#if outBodyText}
          <div class="out-block">
            <div class="out-bar">
              {#if outExpanded || outOverflows}
                <button
                  type="button"
                  class="out-action"
                  aria-expanded={outExpanded}
                  title={outExpanded
                    ? "Collapse the output back to a scrollbox"
                    : "Expand the output to full height"}
                  onclick={() => (outExpanded = !outExpanded)}
                  >{outExpanded ? "Collapse" : "Expand"}</button
                >
              {/if}
              <button
                type="button"
                class="out-action"
                title="Copy this tool's full output to the clipboard"
                onclick={() => copyDetail("output", rawOutputText(item.output))}
                >{copied === "output" ? "Copied" : "Copy"}</button
              >
            </div>
            <pre class="out" class:expanded={outExpanded} bind:this={outPre}>{outBodyText}</pre>
          </div>
        {/if}
      {/if}
      {#if item.status === "running" && !item.text}<div class="running">running…</div>{/if}
      {#if item.status === "interrupted" && item.output === undefined}
        <div class="interrupted">interrupted before a result was recorded</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool {
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    overflow: hidden;
    width: 100%;
    max-width: 680px;
  }
  /* Flat variant (merged-run children): no box of its own — just a row whose only chrome
     is a subtle rounded hover, so successive calls read as a tight list rather than a
     stack of cards. The expanded body keeps its own indentation + inner sunken blocks,
     so it stays legible without a top divider. */
  .tool.flat {
    border: none;
    border-radius: var(--radius-xs);
    background: none;
    overflow: visible;
  }
  .tool.flat .head {
    padding: 4px 7px;
    border-radius: var(--radius-xs);
  }
  .tool.flat .body {
    border-top: none;
    padding: 2px 7px 6px;
  }
  /* When a flat row is expanded, tint the whole card so header + its output read as one
     unit — without the box border, the detail would otherwise float ambiguously between
     this row and the next in the tight list. */
  .tool.flat.open {
    background: var(--surface-sunken);
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    background: none;
    border: none;
    padding: 9px 12px;
    text-align: left;
    color: var(--text);
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .head:hover {
    background: var(--surface-sunken);
  }
  .head:hover :global(.chevron),
  .head:focus-visible :global(.chevron) {
    color: var(--text-muted);
  }
  .head:focus-visible {
    outline: none;
    background: var(--surface-sunken);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .status {
    flex: 0 0 13px;
    font-size: 12px;
    line-height: 1;
    text-align: center;
  }
  .tool.running .status {
    color: var(--accent);
    animation: blink 1s ease-in-out infinite;
  }
  .tool.error .status {
    color: var(--danger);
  }
  .status-accessible {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .status-text {
    flex-shrink: 0;
    color: var(--text-faint);
    font-size: 11.5px;
    font-weight: 500;
  }
  @keyframes blink {
    50% {
      opacity: 0.3;
    }
  }
  .name {
    font-weight: 550;
    font-size: 13.5px;
    flex-shrink: 0;
  }
  .arg {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
    max-width: 52ch;
  }
  .counts {
    display: inline-flex;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 550;
    flex-shrink: 0;
    letter-spacing: -0.01em;
  }
  .counts .add {
    color: var(--ok);
  }
  .counts .del {
    color: var(--danger);
  }
  .counts-omitted {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11.5px;
    flex-shrink: 0;
  }
  /* Elapsed-duration badge — muted + monospace so it reads as metadata, not status. */
  .duration {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-faint);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .body {
    border-top: none;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* The open animation is the shared `transition:reveal` (slide) on this element —
       no separate CSS keyframe (it would double-animate and fight the height glide). */
  }
  pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--surface-sunken);
    border-radius: var(--radius-xs);
    padding: 9px 11px;
    max-height: 320px;
    overflow: auto;
  }
  .out {
    color: var(--text);
  }
  /* Expanded: drop the scrollbox cap so a long log reads top-to-bottom instead of
     trapping a nested scroll (especially on touch, where the overlay scrollbar hides). */
  .out.expanded {
    max-height: none;
  }
  .out-block {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .detail-bar,
  .out-bar {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .out-action {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 9px;
    background: var(--surface);
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .out-action:hover {
    background: var(--surface-sunken);
    color: var(--text);
  }
  .out-action:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1.5px var(--accent);
  }
  /* Sits directly under the header now (not inside .body), so it carries its own
     separator + padding. When the card is also expanded, .body follows with its own
     top border — header | image | details, each delineated. */
  .out-images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    border-top: none;
  }
  /* The image is wrapped in a button so it's keyboard-reachable and opens the
     full-screen viewer; the button carries no chrome — the border lives on the img. */
  .out-img-btn {
    display: block;
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
    max-width: 100%;
    border-radius: var(--radius-xs);
  }
  .out-img-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .out-img {
    max-width: 100%;
    max-height: 360px;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border);
    display: block;
    transition: border-color 0.12s;
  }
  .out-img-btn:hover .out-img {
    border-color: var(--accent);
  }
  .args {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .args-block,
  .stream-block {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .arg-key {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .arg-val {
    color: var(--text);
  }
  @media (max-width: 859px) {
    .out-action {
      min-height: 44px;
      padding-inline: 12px;
    }
  }
  .running,
  .interrupted {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }
  .diff {
    border-radius: var(--radius-xs);
    overflow: auto;
    max-height: 420px;
  }
  .diff-pending {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }
  .edit-detail-bar {
    justify-content: flex-end;
  }
  .diff-note {
    font-size: 11px;
    color: var(--text-muted);
  }
  .diff-error {
    font-size: 12px;
    color: var(--danger);
  }
</style>

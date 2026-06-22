<script lang="ts">
  import { onDestroy } from "svelte";
  import { slide } from "svelte/transition";
  import type { ToolItem } from "@pilot/protocol";
  import Chevron from "./ui/Chevron.svelte";

  let { item }: { item: ToolItem } = $props();
  let open = $state(false);

  // Output controls: the result <pre> is capped at 320px (see .out below), which turns a
  // long log into a nested scroll-trap on touch. Offer a copy + an inline expand that drops
  // the cap. The expand affordance only shows when the collapsed output actually overflows.
  let outExpanded = $state(false);
  let outOverflows = $state(false);
  let outPre = $state<HTMLElement>();
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyOut(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard can reject (permissions / insecure context); leave the UI as-is.
    }
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

  function preview(input: unknown): string {
    if (input == null) return "";
    if (typeof input === "object") {
      const o = input as Record<string, unknown>;
      if (typeof o.command === "string") return o.command;
      if (typeof o.path === "string") return o.path;
      if (typeof o.file_path === "string") return o.file_path;
      return JSON.stringify(input);
    }
    return String(input);
  }

  // Full argument view for the expanded body. The collapsed header only shows a
  // truncated single-line preview() (e.g. the start of a bash command); here we
  // render every argument in full. String values are shown raw so multi-line
  // commands keep their newlines instead of becoming JSON-escaped "\n".
  function argEntries(input: unknown): { key: string; value: string }[] {
    if (input == null) return [];
    if (typeof input !== "object") return [{ key: "", value: String(input) }];
    return Object.entries(input as Record<string, unknown>).map(([key, v]) => ({
      key,
      value: typeof v === "string" ? v : JSON.stringify(v, null, 2),
    }));
  }

  // Live tool results arrive as pi's raw object { content: [{type:"text",text}|{type:"image",data,mimeType}], details? },
  // while replayed-from-history results are already plain text. Pull the text blocks
  // out so a tool card renders the SAME before and after a reload. '' when there are
  // none (or the shape isn't pi's content array).
  function contentText(out: unknown): string {
    if (out && typeof out === "object") {
      const content = (out as { content?: unknown }).content;
      if (Array.isArray(content)) {
        return content
          .map((b) =>
            b &&
            typeof b === "object" &&
            typeof (b as { text?: unknown }).text === "string"
              ? (b as { text: string }).text
              : "",
          )
          .join("");
      }
    }
    return "";
  }

  function outputText(out: unknown): string {
    if (out == null) return "";
    if (typeof out === "string") return out;
    const text = contentText(out);
    if (text) return text;
    return JSON.stringify(out, null, 2);
  }

  // Images the tool returned, lifted into a typed field by the driver (event-map on the
  // live path, history-map on reload) — so the SAME data renders before and after a
  // reconnect, with no sniffing of the raw result shape.
  const outImages = $derived(item.images ?? []);
  // Body text for the result. With images present, show ONLY the accompanying text note
  // (a live object → its text blocks, a replayed string → itself) — never a JSON dump.
  const outBodyText = $derived.by(() => {
    if (item.output === undefined) return "";
    if (outImages.length)
      return typeof item.output === "string"
        ? item.output
        : contentText(item.output);
    return outputText(item.output);
  });

  const statusIcon: Record<ToolItem["status"], string> = {
    running: "○",
    ok: "●",
    error: "✕",
    interrupted: "–",
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
  // Detect pi's edit tool by SHAPE, not name: input is an object with a `path`
  // (string) plus either `edits: [{oldText,newText}]` or legacy top-level
  // oldText/newText strings. `file_path` is an accepted alias for `path` in pi.
  // Contract confirmed in pi's edit.ts / edit-diff.ts.
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

  // Build the two file blobs the diff renders from. Per the task: join each
  // edit's oldTexts / newTexts with newlines (single legacy edit -> used directly).
  function joinSides(edits: Edit[]): { oldFile: string; newFile: string } {
    return {
      oldFile: edits.map((e) => e.oldText).join("\n"),
      newFile: edits.map((e) => e.newText).join("\n"),
    };
  }

  // A pi edit result may carry a richer standard unified patch in details.patch —
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

  // Minimal LCS line diff -> added/removed line counts for the collapsed badge.
  // Pure + dependency-free so the e2e is deterministic; the rich render below
  // does its own (shiki-backed) diffing.
  function lineCounts(oldText: string, newText: string): { added: number; removed: number } {
    const a = oldText.length ? oldText.split("\n") : [];
    const b = newText.length ? newText.split("\n") : [];
    const n = a.length;
    const m = b.length;
    // LCS length table; lcs[i][j] = LCS length of a[i:] and b[j:].
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i] ?? [];
      const next = lcs[i + 1] ?? [];
      for (let j = m - 1; j >= 0; j--) {
        row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    let added = 0;
    let removed = 0;
    while (i < n && j < m) {
      const row = lcs[i] ?? [];
      const next = lcs[i + 1] ?? [];
      if (a[i] === b[j]) {
        i++;
        j++;
      } else if ((next[j] ?? 0) >= (row[j + 1] ?? 0)) {
        removed++;
        i++;
      } else {
        added++;
        j++;
      }
    }
    removed += n - i;
    added += m - j;
    return { added, removed };
  }

  const counts = $derived.by(() => {
    if (!edit) return null;
    let added = 0;
    let removed = 0;
    for (const e of edit.edits) {
      const c = lineCounts(e.oldText, e.newText);
      added += c.added;
      removed += c.removed;
    }
    return { added, removed };
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
    if (!edit) return null;
    const patch = patchFrom(item.output);
    const key = `${theme}::${patch ?? JSON.stringify(edit)}`;
    const cached = diffCache.get(key);
    if (cached) return cached;
    const p = renderDiff(theme, patch);
    // Evict on failure so a transient first-load error (e.g. a theme chunk that
    // briefly failed to resolve) can retry on the next expand instead of being
    // pinned to the rejected promise.
    p.catch(() => diffCache.delete(key));
    diffCache.set(key, p);
    return p;
  }

  async function renderDiff(
    theme: "light" | "dark",
    patch: string | null,
  ): Promise<string> {
    // Dynamic import keeps shiki + the diff machinery out of the initial PWA
    // bundle; only loaded the first time a diff is actually shown. Must use the
    // React-free "/ssr" entry — "." doesn't expose preloadDiffHTML and "/react"
    // pulls in react/react-dom.
    const ssr = await import("@pierre/diffs/ssr");
    const themeOpt = { dark: "github-dark", light: "github-light" } as const;
    if (patch) {
      const res = await ssr.preloadPatchDiff({
        patch,
        options: { theme: themeOpt, themeType: theme, diffStyle: "unified" },
      });
      return res.prerenderedHTML;
    }
    const { path, edits } = edit!;
    const { oldFile, newFile } = joinSides(edits);
    return ssr.preloadDiffHTML({
      oldFile: { name: path, contents: oldFile },
      newFile: { name: path, contents: newFile },
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

<div class="tool {item.status}">
  <button class="head" title={open ? "Collapse tool details" : "Expand tool details"} onclick={() => (open = !open)} aria-expanded={open}>
    <span class="status">{statusIcon[item.status]}</span>
    <span class="name" title={item.description || undefined}>{item.label ?? item.name}</span>
    <span class="arg">{preview(item.input)}</span>
    {#if counts}
      <span class="counts" aria-label="{counts.added} added, {counts.removed} removed">
        <span class="add">+{counts.added}</span>
        <span class="del">−{counts.removed}</span>
      </span>
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
        <img
          class="out-img"
          src={`data:${img.mimeType};base64,${img.data}`}
          alt={`Tool image output ${i + 1}`}
          title="Image returned by this tool"
        />
      {/each}
    </div>
  {/if}
  {#if open}
    <div class="body" transition:slide={{ duration: 160 }}>
      {#if argRows.length}
        <div class="args">
          {#each argRows as row}
            {#if row.key}<div class="arg-key">{row.key}</div>{/if}
            <pre class="arg-val">{row.value}</pre>
          {/each}
        </div>
      {/if}
      {#if item.text}<pre class="stream">{item.text}</pre>{/if}
      {#if edit}
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
                title="Copy this tool's output to the clipboard"
                onclick={() => copyOut(outBodyText)}>{copied ? "Copied" : "Copy"}</button
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
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    overflow: hidden;
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
  .head:focus-visible {
    outline: none;
    background: var(--surface-sunken);
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .status {
    font-size: 9px;
    line-height: 1;
  }
  .tool.running .status {
    color: var(--accent);
    animation: blink 1s ease-in-out infinite;
  }
  .tool.ok .status {
    color: var(--ok);
  }
  .tool.error .status {
    color: var(--danger);
  }
  .tool.interrupted .status {
    color: var(--text-faint);
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
    border-top: 1px solid var(--border);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: reveal 0.16s ease;
  }
  @keyframes reveal {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
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
    border-top: 1px solid var(--border);
  }
  .out-img {
    max-width: 100%;
    max-height: 360px;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border);
    display: block;
  }
  .args {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  .diff-error {
    font-size: 12px;
    color: var(--danger);
  }
</style>

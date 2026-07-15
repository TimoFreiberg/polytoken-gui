// A Svelte action that decorates rendered markdown code blocks with a "copy" button
// pinned to their top-right corner. markstream-svelte owns the `<pre>` it renders
// (we can't slot a Svelte button inside it), so we enhance the DOM after the fact:
// a MutationObserver re-runs the decorate pass as the renderer streams / re-renders,
// and each pass is idempotent (a `data-copy-decorated` marker guards against doubling).
//
// Why wrap rather than append into the `<pre>`: the `<pre>` is the horizontal scroll
// container (overflow-x:auto), so an absolutely-positioned child scrolls away with the
// content on long lines. Wrapping the `<pre>` in a non-scrolling relative box lets the
// button stay pinned to the visible top-right corner.

import { store } from "./store.svelte.js";

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

function makeButton(pre: HTMLPreElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "code-copy";
  btn.innerHTML = COPY_ICON;
  btn.title = "Copy code";
  btn.setAttribute("aria-label", "Copy code");

  let revert: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    // The `<code>` child carries the source text; fall back to the `<pre>` itself.
    const text = (pre.querySelector("code") ?? pre).textContent ?? "";
    // store.copyToClipboard surfaces a rejection (permissions / insecure
    // context) as a visible error instead of a silent no-op.
    if (!(await store.copyToClipboard(text))) return;
    btn.classList.add("copied");
    btn.innerHTML = CHECK_ICON;
    btn.title = "Copied";
    btn.setAttribute("aria-label", "Copied");
    clearTimeout(revert);
    revert = setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = COPY_ICON;
      btn.title = "Copy code";
      btn.setAttribute("aria-label", "Copy code");
    }, 1500);
  });
  return btn;
}

function decorate(pre: HTMLPreElement): void {
  if (pre.dataset.copyDecorated) return;
  pre.dataset.copyDecorated = "1";
  // A capped or horizontally overflowing block is its own scroll region. Make it
  // keyboard-reachable (arrow/Page keys) and name that stop for screen readers.
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Code block");
  const parent = pre.parentNode;
  if (!parent) return;
  const wrap = document.createElement("div");
  wrap.className = "code-block";
  parent.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  wrap.appendChild(makeButton(pre));
}

/** Svelte action: scan `node` for markstream code blocks and pin a copy button on each,
 *  re-running as the renderer streams in / re-renders new blocks. */
export function copyCodeButtons(node: HTMLElement) {
  const scan = () => {
    const blocks = node.querySelectorAll<HTMLPreElement>(
      "pre[data-markstream-code-block]:not([data-copy-decorated])",
    );
    for (const pre of blocks) decorate(pre);
  };
  scan();
  // Only re-scan when an added node is/contains a `<pre>` — the streaming renderer
  // fires many mutation batches (inline text deltas, etc.) that never add code blocks,
  // and a full-subtree querySelectorAll on each one is wasteful during streaming.
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const added of r.addedNodes) {
        if (
          (added instanceof HTMLElement && added.tagName === "PRE") ||
          (added instanceof HTMLElement &&
            added.querySelector("pre[data-markstream-code-block]"))
        ) {
          scan();
          return;
        }
      }
    }
  });
  mo.observe(node, { childList: true, subtree: true });
  return {
    destroy() {
      mo.disconnect();
    },
  };
}

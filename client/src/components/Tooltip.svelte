<script lang="ts">
  // Global tooltip override. Every clickable element in pantoken carries a `title`
  // (a project convention — see AGENTS.md), but the browser's native title tooltip
  // is slow (~1.5s) and unstyled. This single delegated listener reuses those same
  // `title` strings to render a themed tooltip after a short delay instead.
  //
  // Mounted once (in App.svelte); it listens on `document`, so no component needs
  // to opt in — existing `title=` attributes "just work".
  import { onMount, tick } from "svelte";

  const DELAY = 250; // ms a pointer must rest before a tooltip appears

  // Native title tooltips are hover-only; touch never shows them, so don't either.
  const hoverCapable =
    typeof matchMedia === "function" ? matchMedia("(hover: hover)").matches : true;

  let text = $state("");
  let visible = $state(false); // mounted in the DOM (lets us measure it)
  let placed = $state(false); // positioned + faded in
  let x = $state(0);
  let y = $state(0);
  let placement = $state<"top" | "bottom">("top");

  let tipEl = $state<HTMLDivElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raf: number | undefined; // pending mouseout decision (see onOut)
  let current: HTMLElement | null = null; // element we're showing/scheduling for
  let single = $state(false); // source has data-tip-single → clamp to 1 line
  let suppressed = false; // did we strip current's native `title`?

  // Begin showing for `el`. On the hover path we strip the native `title` so the
  // browser's own tooltip doesn't double up with ours; on the keyboard-focus path
  // we leave it in place (no native tooltip fires on focus, and keeping `title`
  // preserves the element's accessible name/description).
  function begin(el: HTMLElement, suppressNative: boolean) {
    if (el === current) return;
    end();
    const t = el.getAttribute("title");
    if (!t) return;
    current = el;
    text = t;
    single = el.dataset.tipSingle !== undefined;
    if (suppressNative) {
      el.setAttribute("data-tip-title", t);
      el.removeAttribute("title");
      suppressed = true;
    }
    timer = setTimeout(reveal, DELAY);
  }

  function end() {
    clearTimeout(timer);
    timer = undefined;
    if (raf != null) {
      cancelAnimationFrame(raf);
      raf = undefined;
    }
    if (suppressed && current) {
      const t = current.getAttribute("data-tip-title");
      if (t != null) current.setAttribute("title", t);
      current.removeAttribute("data-tip-title");
    }
    current = null;
    suppressed = false;
    visible = false;
    placed = false;
  }

  async function reveal() {
    if (!current) return;
    visible = true;
    await tick(); // wait for the tip to render so we can measure it
    if (!current || !tipEl) return;
    const r = current.getBoundingClientRect();
    const tip = tipEl.getBoundingClientRect();
    const gap = 8;
    const edge = 6;
    let top = r.top - tip.height - gap;
    placement = "top";
    if (top < edge) {
      top = r.bottom + gap;
      placement = "bottom";
    }
    let left = r.left + r.width / 2 - tip.width / 2;
    left = Math.max(edge, Math.min(left, innerWidth - tip.width - edge));
    x = Math.round(left);
    y = Math.round(top);
    placed = true;
  }

  function onOver(e: MouseEvent) {
    if (!hoverCapable) return;
    const el = (e.target as Element | null)?.closest<HTMLElement>("[title]");
    if (el) begin(el, true);
  }

  function onOut(e: MouseEvent) {
    // Only react to leaving the element we're tracking — ignore stray mouseouts
    // from elsewhere (e.g. while a focus-driven tooltip is up).
    if (!current) return;
    const target = e.target as Node | null;
    const to = e.relatedTarget as Node | null;
    if (!(target && current.contains(target) && !(to && current.contains(to)))) return;
    // A mouseout has two very different causes:
    //   1. the pointer genuinely left the element  → close
    //   2. the element's DOM node was replaced by a re-render under a still
    //      resting pointer (e.g. tool-progress updates in a warm session). The
    //      browser fires mouseout for the removed node but NO mouseover for its
    //      replacement, so closing here would strand the tooltip for good.
    // Defer one frame so any replacement node is in place, then decide by what is
    // actually under the pointer rather than by the (possibly detached) old node.
    const px = e.clientX;
    const py = e.clientY;
    const leaving = current;
    if (raf != null) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = undefined;
      // Pointer already moved onto another titled element, which started its own
      // tooltip — let that path own the state.
      if (current !== leaving) return;
      // Node still attached → the pointer really left it.
      if (document.contains(leaving)) {
        end();
        return;
      }
      // Node was removed by a re-render. Re-acquire only if the element now under
      // the resting pointer is plausibly the SAME control re-rendered — not merely
      // a neighbour sharing the title string (pantoken has many: per-row "Worktree: …",
      // action buttons, …). Match the title plus the identity a re-render preserves
      // (tag + aria-label + testid); anything else means the content changed → close.
      const under = document.elementFromPoint(px, py);
      const el = under?.closest<HTMLElement>("[title]");
      if (
        el &&
        el.getAttribute("title") === text &&
        el.tagName === leaving.tagName &&
        el.getAttribute("aria-label") === leaving.getAttribute("aria-label") &&
        el.getAttribute("data-testid") === leaving.getAttribute("data-testid")
      ) {
        current = el;
        single = el.dataset.tipSingle !== undefined;
        el.setAttribute("data-tip-title", text);
        el.removeAttribute("title");
        suppressed = true;
        if (visible) reveal();
      } else {
        end();
      }
    });
  }

  function onFocusIn(e: FocusEvent) {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[title]");
    // Keyboard nav only — a touch tap also focuses, but isn't :focus-visible.
    if (el && el.matches(":focus-visible")) begin(el, false);
  }

  function onFocusOut(e: FocusEvent) {
    if (current && e.target === current) end();
  }

  onMount(() => {
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Any of these means the moment for a resting-pointer tooltip has passed.
    window.addEventListener("scroll", end, true);
    window.addEventListener("wheel", end, { passive: true });
    window.addEventListener("pointerdown", end);
    window.addEventListener("blur", end);
    document.addEventListener("keydown", onKey);
    return () => {
      end();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", end, true);
      window.removeEventListener("wheel", end);
      window.removeEventListener("pointerdown", end);
      window.removeEventListener("blur", end);
      document.removeEventListener("keydown", onKey);
    };
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") end();
  }
</script>

{#if visible}
  <div
    bind:this={tipEl}
    class="tip {placement}"
    class:in={placed}
    class:single
    style="left: {x}px; top: {y}px"
    role="tooltip"
    aria-hidden="true"
  >
    {text}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 1000; /* above every modal/toast/lightbox (max in-app is the lightbox at 90) */
    max-width: 280px;
    padding: 5px 9px;
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.35;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
    box-shadow: var(--shadow-pop);
    pointer-events: none; /* never intercept the hover it's describing */
    white-space: pre-line; /* honor newlines in titles, wrap long ones */
    opacity: 0;
    transform: translateY(2px);
    transition:
      opacity 90ms ease,
      transform 90ms ease;
  }
  /* Single-line variant: source element has data-tip-single. Clamps to one
     visual line — prevents a long first-user-message preview from ballooning. */
  .tip.single {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tip.bottom {
    transform: translateY(-2px);
  }
  .tip.in {
    opacity: 1;
    transform: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .tip {
      transition: opacity 90ms ease;
      transform: none;
    }
  }
</style>

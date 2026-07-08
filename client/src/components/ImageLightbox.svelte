<script lang="ts">
  import type { ImageContent } from "@pantoken/protocol";

  // Full-screen preview of an attached image. Modal scrim over everything (z 90, below
  // tooltips at 1000); click the backdrop or press Escape to dismiss, ←/→ to walk a
  // multi-image batch. The image bytes are the same base64 data URL the thumbnail uses —
  // no extra fetch.
  interface Props {
    images: readonly ImageContent[];
    index: number;
    onClose: () => void;
    onIndex: (i: number) => void;
  }

  let { images, index, onClose, onIndex }: Props = $props();

  const current = $derived(images[index]);
  const count = $derived(images.length);

  function step(delta: number) {
    if (count < 2) return;
    onIndex((index + delta + count) % count);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      step(1);
    }
  }

  // Autofocus the dialog so the keyboard shortcuts land here and a printable key can't
  // leak to the composer's type-to-focus handler.
  function focusOnMount(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if current}
  <!-- Backdrop: clicking outside the image dismisses (role=presentation — the dialog
       below owns the semantics). -->
  <div
    class="lightbox-scrim"
    role="presentation"
    onclick={onClose}
    data-testid="image-lightbox"
  >
    <div
      class="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview ${index + 1} of ${count}`}
      tabindex="-1"
      use:focusOnMount
    >
      <!-- Stop clicks on the figure from bubbling to the scrim (which would close). -->
      <figure class="stage" onclick={(e) => e.stopPropagation()} role="presentation">
        <img src="data:{current.mimeType};base64,{current.data}" alt={`Attachment ${index + 1}`} />
      </figure>

      {#if count > 1}
        <button
          class="nav prev"
          onclick={(e) => {
            e.stopPropagation();
            step(-1);
          }}
          title="Previous image (←)"
          aria-label="Previous image"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          class="nav next"
          onclick={(e) => {
            e.stopPropagation();
            step(1);
          }}
          title="Next image (→)"
          aria-label="Next image"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <span class="counter" aria-hidden="true">{index + 1} / {count}</span>
      {/if}

      <button
        class="close"
        onclick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close preview (Esc)"
        aria-label="Close preview"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .lightbox-scrim {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
      env(safe-area-inset-bottom) env(safe-area-inset-left);
    background: color-mix(in srgb, #000 72%, transparent);
    backdrop-filter: blur(2px);
  }
  /* Fills the scrim so close/nav/counter anchor to the screen edges, not the (possibly
     tiny) image's edges. Clicks on this empty area bubble to the scrim and dismiss; the
     figure and chrome buttons stop propagation. */
  .lightbox {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    outline: none;
  }
  .stage {
    margin: 0;
    display: grid;
    place-items: center;
  }
  .stage img {
    display: block;
    max-width: 92vw;
    max-height: 88vh;
    object-fit: contain;
    border-radius: var(--radius-sm);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    background: var(--surface-sunken);
  }

  /* Chrome buttons share a translucent dark pill so they read on any image. */
  .close,
  .nav {
    position: absolute;
    display: grid;
    place-items: center;
    color: #fff;
    background: color-mix(in srgb, #000 45%, transparent);
    border: 1px solid color-mix(in srgb, #fff 22%, transparent);
    border-radius: 999px;
    cursor: pointer;
    backdrop-filter: blur(4px);
    transition:
      background 0.12s,
      transform 0.12s;
  }
  .close:hover,
  .nav:hover {
    background: color-mix(in srgb, #000 65%, transparent);
  }
  .close:focus-visible,
  .nav:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .close {
    top: 10px;
    right: 10px;
    width: 40px;
    height: 40px;
    font-size: 26px;
    font-weight: 600;
    line-height: 1;
  }
  .nav {
    top: 50%;
    transform: translateY(-50%);
    width: 44px;
    height: 44px;
  }
  .nav:hover {
    transform: translateY(-50%) scale(1.06);
  }
  .nav.prev {
    left: 10px;
  }
  .nav.next {
    right: 10px;
  }
  .counter {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 10px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: #fff;
    background: color-mix(in srgb, #000 45%, transparent);
    border-radius: 999px;
    backdrop-filter: blur(4px);
    user-select: none;
  }

  @media (pointer: coarse) {
    .close {
      width: 44px;
      height: 44px;
    }
    .nav {
      width: 48px;
      height: 48px;
    }
  }
</style>

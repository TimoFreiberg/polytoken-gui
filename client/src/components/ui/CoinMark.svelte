<script lang="ts">
  // The app's mark — the icon's token, a coin with a square mint-hole — as a
  // monochrome inline glyph for spinners and other tiny chrome where the
  // full-color tile would be noise. Stroked in currentColor so the parent's
  // `color` sets the mood (accent while working, faint while opening).
  // Decorative: aria-hidden here; the owning element carries the label.
  let {
    size = 14,
    strokeWidth = 2.4,
  }: {
    size?: number;
    strokeWidth?: number;
  } = $props();
</script>

<span class="coin-mark" aria-hidden="true">
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <rect x="8.5" y="8.5" width="7" height="7" rx="1.75" />
  </svg>
</span>

<style>
  .coin-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
</style>

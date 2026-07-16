<script lang="ts">
  // The panel show/hide glyph for sidebar toggle buttons — a rounded rectangle
  // with an internal vertical divider, read as "toggle this panel." Distinct from
  // <Chevron>, which is the shared glyph for inline disclosure/dropdown sections
  // (rotates with open/closed state). This icon is static and directionless; the
  // `side` prop only controls which edge the divider sits on:
  //   side="left"  → panel-left  (divider at x=9)  — sessions sidebar toggles.
  //   side="right" → panel-right (divider at x=15) — context panel toggles.
  //
  // Decorative (aria-hidden): the owning button carries the label + aria-expanded.
  // Color is inherited (currentColor), matching the existing header icons.
  let {
    side = "left",
    size = 15,
  }: {
    side?: "left" | "right";
    size?: number;
  } = $props();

  const dividerX = $derived(side === "right" ? 15 : 9);
</script>

<span class="panel-icon" aria-hidden="true">
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1={dividerX} y1="3" x2={dividerX} y2="21" />
  </svg>
</span>

<style>
  .panel-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
</style>

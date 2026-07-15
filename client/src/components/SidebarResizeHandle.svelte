<script lang="ts">
  import { onDestroy } from "svelte";

  let {
    side,
    value,
    min,
    max,
    label,
    onChange,
  }: {
    side: "left" | "right";
    value: number;
    min: number;
    max: number;
    label: string;
    onChange: (width: number) => void;
  } = $props();

  let dragging = $state(false);
  let startX = 0;
  let startWidth = 0;
  let activePointer: number | null = null;

  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const deltaFor = (clientX: number) =>
    side === "left" ? clientX - startX : startX - clientX;

  function protectDocument(): void {
    document.documentElement.style.userSelect = "none";
    document.documentElement.style.cursor = "col-resize";
  }
  function restoreDocument(): void {
    document.documentElement.style.userSelect = "";
    document.documentElement.style.cursor = "";
  }
  function finish(): void {
    if (!dragging) return;
    dragging = false;
    activePointer = null;
    restoreDocument();
  }
  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch" || window.matchMedia("(max-width: 859px)").matches) return;
    event.preventDefault();
    dragging = true;
    activePointer = event.pointerId;
    startX = event.clientX;
    startWidth = value;
    protectDocument();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent): void {
    if (!dragging || activePointer !== event.pointerId) return;
    onChange(clamp(startWidth + deltaFor(event.clientX)));
  }
  function onPointerUp(event: PointerEvent): void {
    if (activePointer !== event.pointerId) return;
    finish();
  }
  $effect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => onPointerMove(event);
    const up = (event: PointerEvent) => onPointerUp(event);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  })
  function onPointerCancel(): void {
    finish();
  }
  function onKeydown(event: KeyboardEvent): void {
    const direction = side === "left" ? 1 : -1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = value + 16 * direction;
    else if (event.key === "ArrowLeft") next = value - 16 * direction;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  }

  $effect(() => {
    const onBlur = () => finish();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  });
  onDestroy(() => {
    restoreDocument();
  });
</script>

<button
  class="resize-handle"
  class:dragging
  class:right={side === "right"}
  type="button"
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  title={`${label} — use arrow keys, Home, or End`}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={(event) => onPointerUp(event)}
  onpointercancel={onPointerCancel}
  onlostpointercapture={onPointerCancel}
  onkeydown={onKeydown}
></button>

<style>
  .resize-handle {
    appearance: none;
    border: 0;
    background: transparent;
    position: absolute;
    top: 0;
    bottom: 0;
    right: -1px;
    z-index: 10;
    width: 8px;
    padding: 0;
    cursor: col-resize;
    touch-action: none;
  }
  .resize-handle::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    transform: translateX(-50%);
    background: transparent;
    border-radius: 999px;
    transition: background 120ms ease;
  }
  .resize-handle:hover::after,
  .resize-handle:focus-visible::after,
  .resize-handle.dragging::after {
    background: color-mix(in srgb, var(--accent) 42%, transparent);
  }
  .resize-handle.right {
    left: -1px;
    right: auto;
  }
  @media (max-width: 859px) {
    .resize-handle { display: none; }
  }
</style>

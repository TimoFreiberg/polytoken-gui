// Keep the bottom-anchored composer above the on-screen keyboard. On iOS Safari the soft
// keyboard shrinks the VISUAL viewport but NOT the layout viewport (`100dvh` / innerHeight
// stay put), so a bottom-pinned bar ends up behind the keyboard — or the browser scrolls the
// focused field up and off-screen. We measure the keyboard's overlap from the visualViewport
// API and publish it as a `--keyboard-inset` CSS var; the app shrinks by it (on touch) so the
// composer rides just above the keyboard. Progressive enhancement: where visualViewport is
// absent the var stays unset (0) and nothing changes. Pure core kept DOM-free for testing.

/** How many px the on-screen keyboard overlaps the bottom of the layout viewport.
 *  `innerHeight` is the layout viewport height; `height`/`offsetTop` come from
 *  `visualViewport` (offsetTop is non-zero when iOS has scrolled the page under the keyboard).
 *  Clamped to >= 0 (a negative means no overlap, e.g. a URL bar reflow) and rounded so
 *  sub-pixel jitter doesn't thrash the layout. */
export function keyboardInset(m: {
  innerHeight: number;
  height: number;
  offsetTop: number;
}): number {
  return Math.max(0, Math.round(m.innerHeight - m.height - m.offsetTop));
}

/** Wire the visualViewport to a `--keyboard-inset` CSS var on <html>, updated as the keyboard
 *  shows/hides (resize) and as iOS shifts the focused field (scroll). Returns a cleanup that
 *  drops the listeners and resets the var. No-op when there's no visualViewport — desktop and
 *  older browsers keep the default 0. */
export function trackKeyboardInset(win: Window = window): () => void {
  const vv = win.visualViewport;
  const root = win.document.documentElement;
  if (!vv) return () => {};
  const apply = () => {
    const inset = keyboardInset({
      innerHeight: win.innerHeight,
      height: vv.height,
      offsetTop: vv.offsetTop,
    });
    root.style.setProperty("--keyboard-inset", `${inset}px`);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    root.style.removeProperty("--keyboard-inset");
  };
}

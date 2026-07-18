import { expect, test } from "@playwright/test";
import { drive, gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

// The pinned-scroll drift watcher: when the viewport is pinned to the bottom but has drifted
// far from it (gap > 200px) after a height-churn event the follow logic missed (work-block
// collapse, markstream reflow, image decode — none tick `contentSize`, and the ratio-restore
// ResizeObserver re-assert is settle-window-gated), the watcher self-heals by re-asserting
// scrollTo(bottom) and — only with ?dev — raises a sticky "Copy trace" notice.
//
// FORCING THE DRIFT: growing content under a pinned viewport is non-reproducible in headless
// Chromium — Chrome's `overflow-anchor` keeps the gap near 0 on growth (documented at
// e2e/scroll-follow.e2e.ts:4-10). A content-height shrink is also masked: Chrome clamps
// scrollTop down to the new max and fires a scroll event that re-pins before the watcher
// sees the drift. The reliable forcing method is to DISABLE `overflow-anchor` on the scroller
// (simulating iOS Safari, where overflow-anchor is unreliable — the real-world failure
// surface) and then grow the DOM directly: append a tall spacer as a SIBLING of `.col`
// (directly under `.scroller`), NOT as a child of `.col`. This grows scrollHeight without
// changing `.col`'s height, so the ResizeObserver on `.col` doesn't fire — Phase 1's fix
// (#57) re-asserts the bottom on every `.col` height change while pinned, which would close
// the gap before the drift watcher sees it. `contentSize` (Svelte items) doesn't tick either,
// so the streaming-pin effect doesn't re-run; and with overflow-anchor off, Chrome does NOT
// adjust scrollTop on growth, so no scroll event fires and `pinned` stays true — producing
// `pinned && gap > threshold`, the exact state the watcher targets.

/** Read the current gap (scrollHeight - scrollTop - clientHeight) of the scroller. */
function gapFn(scroller: import("@playwright/test").Locator) {
  return scroller.evaluate(
    (el) =>
      (el as HTMLElement).scrollHeight -
      (el as HTMLElement).scrollTop -
      (el as HTMLElement).clientHeight,
  );
}

/** Append a tall spacer as a sibling of `.col` (under `.scroller`), growing scrollHeight
 *  without changing `.col`'s height — so the ResizeObserver on `.col` doesn't fire and
 *  Phase 1's live-bottom re-assert (#57) doesn't close the gap before the watcher sees it.
 *  `contentSize` (Svelte items) is unchanged too. With overflow-anchor disabled,
 *  scrollTop stays put and the gap opens — forcing `pinned && gap > threshold`. */
async function forceDrift(page: import("@playwright/test").Page): Promise<void> {
  const scroller = page.locator(".scroller");
  // Disable overflow-anchor so Chrome doesn't mask the drift on growth.
  await scroller.evaluate((el) => {
    (el as HTMLElement).style.overflowAnchor = "none";
  });
  // Wait for the settle window (500ms) to lapse so the ratio-restore ResizeObserver
  // branch won't re-assert. (The live-bottom branch doesn't fire because the spacer
  // is appended to the scroller, not .col — see below.)
  await page.waitForTimeout(1500);
  // Grow the DOM: append a tall spacer. scrollTop stays put → gap opens.
  // Append the spacer to the SCROLLER (not .col) so it grows scrollHeight
  // WITHOUT changing .col's height — Phase 1's ResizeObserver fix re-asserts
  // the bottom on every .col height change while pinned, which would close the
  // gap before the drift watcher sees it. A scroller-level sibling grows
  // scrollHeight (the gap the watcher samples) without triggering the
  // ResizeObserver on .col.
  await scroller.evaluate((el) => {
    const spacer = document.createElement("div");
    spacer.id = "test-drift-spacer";
    spacer.style.height = "2000px";
    el.appendChild(spacer);
  });
}

/** Remove the injected drift spacer and restore the scroller's overflow-anchor. */
async function cleanupDrift(page: import("@playwright/test").Page): Promise<void> {
  await page.locator(".scroller").evaluate((el) => {
    (el as HTMLElement).style.overflowAnchor = "";
    document.getElementById("test-drift-spacer")?.remove();
  });
}

// ── AC.1, AC.3-positive, AC.4: ?dev present — self-heal + notice + trace copy ─────────

test.describe("with ?dev flag", () => {
  test.beforeEach(async ({ page }) => {
    await gotoFresh(page);
    // Build a tall transcript so the scroller pins to the bottom and top != bottom.
    for (let i = 0; i < 4; i++) {
      await drive(page, "reply");
      await expect(
        page.getByText("That confirms it", { exact: false }).last(),
      ).toBeVisible();
    }
    await waitForSettledWorkBlocks(page, 5);
  });

  test("AC.1 — a pinned drift self-corrects with no user scroll", async ({ page }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);

    // Start pinned at the bottom.
    await expect.poll(gap).toBeLessThan(80);

    await forceDrift(page);

    // Confirm the drift actually occurred before the watcher corrects it — the gap should
    // open above threshold. This proves the test staged a real drift, not just a small gap.
    await expect.poll(gap, { timeout: 1000 }).toBeGreaterThan(200);

    // The gap should then self-heal below threshold — with NO simulated user scroll. The
    // watcher's 250ms interval catches and corrects it.
    await expect.poll(gap, { timeout: 5000 }).toBeLessThan(200);

    await cleanupDrift(page);
  });

  test("AC.3 — a drift episode raises a sticky notice with a Copy trace action", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);

    await expect.poll(gap).toBeLessThan(80);
    await forceDrift(page);

    // The sticky notice appears (durationMs: 0) with the gap shown + a Copy trace action.
    const notice = page.getByTestId("chat-notice");
    await expect(notice).toBeVisible({ timeout: 5000 });
    await expect(notice).toContainText("Scroll drift self-corrected");
    await expect(notice).toContainText("Copy trace");

    await cleanupDrift(page);
  });

  test("AC.4 — Copy trace copies a JSON trace to the clipboard and dismisses the toast", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);

    await expect.poll(gap).toBeLessThan(80);
    await forceDrift(page);

    const notice = page.getByTestId("chat-notice");
    await expect(notice).toBeVisible({ timeout: 5000 });

    // Click "Copy trace" — NoticeItem awaits action.run() (the async clipboard write) then
    // calls onDismiss, so the toast dismisses only after the clipboard write completes.
    await notice.getByRole("button", { name: "Copy trace" }).click();

    // The toast auto-dismisses on the action click.
    await expect(notice).toHaveCount(0);

    // The clipboard contains the trace: a header with the marker, then per-sample lines.
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const lines = clip.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    const header = JSON.parse(lines[0]!);
    expect(header.pantokenScrollDriftTrace).toBe(true);
    expect(typeof header.detectedAt).toBe("number");
    expect(typeof header.ua).toBe("string");
    expect(header.viewport).toEqual({
      w: expect.any(Number),
      h: expect.any(Number),
    });
    // Each sample line is a JSON object with the named fields.
    const sample = JSON.parse(lines[1]!);
    expect(sample).toEqual({
      t: expect.any(Number),
      scrollTop: expect.any(Number),
      scrollHeight: expect.any(Number),
      clientHeight: expect.any(Number),
      gap: expect.any(Number),
      pinned: expect.any(Boolean),
      turnActive: expect.any(Boolean),
    });

    await cleanupDrift(page);
  });

  test("AC.5 — a single drift episode raises exactly one notice (no toast storm)", async ({
    page,
  }) => {
    const scroller = page.locator(".scroller");
    const gap = () => gapFn(scroller);

    await expect.poll(gap).toBeLessThan(80);
    await forceDrift(page);

    // Wait past several watcher intervals (250ms each) so a storm would show.
    await page.waitForTimeout(1500);

    // Exactly one TOAST — the latch fires once per episode, not every tick. Assert on the
    // per-item testid inside the container, not the container itself (the container is a
    // single wrapper div that's always count=1 when any toast exists — it can't detect a storm).
    await expect(
      page.getByTestId("chat-notice").getByTestId("toast"),
    ).toHaveCount(1);

    await cleanupDrift(page);
  });
});

// ── AC.2, AC.3-negative: ?dev absent — self-heal works, no notice ─────────────────────

test("AC.2/AC.3 — without ?dev, self-heal still works but no notice appears", async ({
  page,
}) => {
  // Stage the fixture with ?dev on (gotoFresh navigates to /?dev and drives the mock).
  await gotoFresh(page);
  for (let i = 0; i < 4; i++) {
    await drive(page, "reply");
    await expect(
      page.getByText("That confirms it", { exact: false }).last(),
    ).toBeVisible();
  }
  await waitForSettledWorkBlocks(page, 5);

  // Reload WITHOUT ?dev. The mock-driver session state persists server-side (the dev server
  // process stays running, so in-memory mock state survives); the app reconnects and
  // re-pins to the bottom. The transcript content is still there (the work blocks render).
  await page.goto("/");
  await waitForSettledWorkBlocks(page, 5);

  const scroller = page.locator(".scroller");
  const gap = () => gapFn(scroller);

  // Confirm we're pinned at the bottom after the reload.
  await expect.poll(gap).toBeLessThan(80);

  await forceDrift(page);

  // AC.2: the self-heal is NOT dev-gated — the gap self-corrects with no user scroll.
  await expect.poll(gap, { timeout: 5000 }).toBeLessThan(200);

  // AC.3-negative: no notice appears without ?dev.
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("chat-notice")).toHaveCount(0);

  await cleanupDrift(page);
});

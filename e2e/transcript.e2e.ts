import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
  openSettings,
  waitForSettledWorkBlocks,
} from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("an extension compatibility issue folds into a warning notice", async ({
  page,
}) => {
  await drive(page, "compat");
  const notice = page.locator(".notice.warning");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Extension capability "custom"');
  await expect(notice).toContainText("terminal-only");
});

test("renders the greeting conversation: user, collapsed work, final answer", async ({
  page,
}) => {
  // User prompt + the turn-final answer are always visible…
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(page.getByText("Routes live in")).toBeVisible();
  // …but the working section (narration + tool) is collapsed behind "Worked for Ns".
  await expect(page.getByTestId("work-toggle")).toContainText("Worked for");
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toHaveCount(0);
  await expect(page.getByText("Run shell command")).toHaveCount(0);

  // Expanding reveals the narration and the one-tool bash card.
  await expandWork(page);
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toBeVisible();
  const tool = page.getByTestId("work-body").locator(":scope > .tool");
  await expect(tool).toHaveCount(1);
  await expect(tool.locator(":scope > .head .name")).toHaveText(
    "Run shell command",
  );
});

test("the composer footer shows the model; healthy connection chrome stays quiet", async ({
  page,
}) => {
  // The model label lives in the composer status row (moved out of the header).
  await expect(
    page.getByTestId("composer-status-right").getByTestId("model-badge"),
  ).toContainText("Claude Opus 4.8");
  await expect(page.locator(".hdr .conn")).toHaveCount(0);
});

test("tool card expands to show output", async ({ page }) => {
  await expandWork(page);
  const head = page.getByTestId("work-body").locator(":scope > .tool > .head");
  await expect(head).toBeVisible();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

test("tool card expands to show the full arguments", async ({ page }) => {
  await expandWork(page);
  const head = page.getByTestId("work-body").locator(":scope > .tool > .head");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  // The args block labels each input key and shows its full value in a <pre> —
  // the collapsed header only renders a truncated single-line preview.
  const args = page.locator(".tool .args");
  await expect(args.locator(".arg-key", { hasText: "command" })).toBeVisible();
  await expect(args.locator(".arg-val")).toContainText(
    'rg -n "app.get\\(" server/src',
  );
});

test("composer is present and idle", async ({ page }) => {
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();
});

test("with thinking hidden, all superseded thinking-only items are dropped", async ({
  page,
}) => {
  // Default is thinking-hidden. The thinkingtools fixture interleaves a thinking-only
  // bubble between every tool call (bash → think → bash → think → read → think → bash).
  // Every thinking-only item is followed by a tool or text, so all are superseded
  // and dropped — no collapsed stubs remain.
  await drive(page, "thinkingtools");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page);
  const work = page.getByTestId("work-body").last();
  // Four individual tool cards, no prose summary wrapping them.
  await expect(work.locator(":scope > .tool")).toHaveCount(4);
  await expect(work.locator(":scope > .tool.summary")).toHaveCount(0);
  // All thinking-only blocks are superseded (each followed by a tool) → none render.
  await expect(work.getByText("Thought process")).toHaveCount(0);
});

test("with thinking visible, thinking blocks sit between the tool cards", async ({
  page,
}) => {
  // Reveal thinking, then run the same fixture. Now the thinking bubbles are visible
  // content: four standalone tool cards with a "Thought process" block between each pair.
  await openSettings(page, "appearance");
  await page.getByTestId("hide-thinking").click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await drive(page, "thinkingtools");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page);
  const work = page.getByTestId("work-body").last();
  await expect(work.locator(":scope > .tool")).toHaveCount(4);
  await expect(work.getByText("Thought process")).toHaveCount(3);
});

// Regression: scrolling up through history must not move the viewport on its own.
// CSS `content-visibility: auto` + an estimated `contain-intrinsic-size` on transcript
// rows made off-screen rows stand in at a placeholder height, then snap to their real
// (taller) height as you scrolled up — injecting height above the viewport and drifting
// it downward (the view "jumped" into a tall message). Render every row at true height
// instead so scrollHeight is constant regardless of scroll position.
//
// This was fixed then reverted-by-readdition; guard the invariant so it can't silently
// come back. The first assertion pins the exact fix (rows must not use CV:auto); the
// second pins the user-visible behavior (scrollHeight doesn't grow when scrolling up).
test("scrolling up does not move the viewport (no content-visibility lazy realization)", async ({
  page,
}) => {
  const scroller = page.locator(".scroller");

  // Build a transcript taller than the viewport with a few markdown turns.
  for (let i = 0; i < 6; i++) {
    await drive(page, "markdown");
    await expect(
      page.getByText("Show me a markdown formatting sample."),
    ).toHaveCount(i + 1);
    const overflow = await scroller.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    if (overflow > 400) break;
  }

  // Let streaming settle: wait until scrollHeight stops changing between reads.
  let prev = -1;
  await expect
    .poll(
      async () => {
        const h = await scroller.evaluate((el) => el.scrollHeight);
        const stable = h === prev;
        prev = h;
        return stable;
      },
      { intervals: [150, 150, 200, 300, 500], timeout: 6000 },
    )
    .toBe(true);

  // Guard the exact fix: transcript rows must NOT use content-visibility:auto.
  const cv = await scroller
    .locator(".row")
    .first()
    .evaluate((el) => getComputedStyle(el).contentVisibility);
  expect(cv).not.toBe("auto");

  // Behavioral invariant: with no lazy realization, scrollHeight is constant
  // regardless of scroll position — nothing grows above the viewport as you scroll up.
  const hBottom = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollHeight;
  });
  const hTop = await scroller.evaluate((el) => {
    el.scrollTop = 0;
    return el.scrollHeight;
  });
  expect(hTop).toBe(hBottom);
});

test("a long user prompt renders clamped with an expand/collapse toggle", async ({
  page,
}) => {
  // 14 lines — over the ~10-line clamp threshold. Sent through the composer so
  // the optimistic row AND the mock's echoed userMessage both exercise the clamp.
  const longPrompt = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const box = page.locator(".composer-wrap textarea");
  await box.fill(longPrompt);
  await box.press("Enter");

  const bubble = page.locator(".row.user .btext", { hasText: "line 14" });
  await expect(bubble).toHaveClass(/clamped/);

  // Expand: the clamp lifts and the toggle flips to collapse.
  const toggle = page.getByTestId("prompt-expand");
  await expect(toggle).toHaveText(/Show full prompt/);
  await toggle.click();
  await expect(bubble).not.toHaveClass(/clamped/);
  await expect(toggle).toHaveText(/Show less/);

  // Collapse back to the preview.
  await toggle.click();
  await expect(bubble).toHaveClass(/clamped/);
});

test("a short user prompt has no expand toggle", async ({ page }) => {
  const box = page.locator(".composer-wrap textarea");
  await box.fill("just a short question");
  await box.press("Enter");
  await expect(
    page.locator(".row.user .bubble", { hasText: "just a short question" }),
  ).toBeVisible();
  await expect(page.getByTestId("prompt-expand")).toHaveCount(0);
});

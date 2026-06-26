import { expect, test } from "@playwright/test";
import {
  drive,
  expandWork,
  gotoFresh,
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

  // Expanding reveals the narration and the one-tool bash summary.
  await expandWork(page);
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toBeVisible();
  const summary = page.locator(".tool.summary");
  await expect(summary.locator(":scope > .head .label")).toHaveText(
    "Ran a command",
  );
});

test("the composer footer shows the model; the header shows a live connection", async ({
  page,
}) => {
  // The model label lives in the composer footer now (moved out of the header).
  await expect(
    page
      .locator(".composer-wrap .mp .badge")
      .filter({ hasText: "Claude Opus 4.8" }),
  ).toBeVisible();
  await expect(
    page.locator(".hdr").getByText("live", { exact: true }),
  ).toBeVisible();
});

test("tool card expands to show output", async ({ page }) => {
  await expandWork(page);
  const summary = page.locator(".tool.summary");
  await summary.locator(":scope > .head").click();
  const innerHead = summary.locator(":scope > .body > .tool > .head");
  await expect(innerHead).toBeVisible();
  await innerHead.click();
  await expect(innerHead).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

test("tool card expands to show the full arguments", async ({ page }) => {
  await expandWork(page);
  const summary = page.locator(".tool.summary");
  await summary.locator(":scope > .head").click();
  const innerHead = summary.locator(":scope > .body > .tool > .head");
  await expect(innerHead).toBeVisible();
  await innerHead.click();
  await expect(innerHead).toHaveAttribute("aria-expanded", "true");
  // The args block labels each input key and shows its full value in a <pre> —
  // the collapsed header only renders a truncated single-line preview.
  const args = page.locator(".tool .args");
  await expect(args.locator(".arg-key", { hasText: "command" })).toBeVisible();
  await expect(args.locator(".arg-val")).toContainText(
    'rg -n "app.get\\(" server/src',
  );
});

test("composer is present and idle", async ({ page }) => {
  await expect(page.getByPlaceholder("Message pilot…")).toBeVisible();
});

test("with thinking hidden, tools separated only by thinking merge into one card", async ({
  page,
}) => {
  // Default is thinking-hidden. The thinkingtools fixture interleaves a thinking-only
  // bubble between every tool call (bash → think → bash → think → read → think → bash).
  // Those gaps render nothing, so the four tools fold into ONE summary card.
  await drive(page, "thinkingtools");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page);
  const work = page.getByTestId("work-body").last();
  await expect(work.locator(".tool.summary")).toHaveCount(1);
  await expect(work.locator(".tool.summary > .head .label")).toHaveText(
    "Ran 3 commands, read a file",
  );
  // Nothing thinking-shaped survives — the bubbles between tools were dropped.
  await expect(work.getByText("Thought process")).toHaveCount(0);
});

test("with thinking visible, the same run fragments around the thinking blocks", async ({
  page,
}) => {
  // Reveal thinking, then run the same fixture. Now the thinking bubbles are visible
  // content, so they legitimately break the run: four standalone tool cards with a
  // "Thought process" block between each pair.
  await page.locator('button[title^="Settings"]').click();
  await page.getByTestId("hide-thinking").click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await drive(page, "thinkingtools");
  await waitForSettledWorkBlocks(page, 2);
  await expandWork(page);
  const work = page.getByTestId("work-body").last();
  await expect(work.locator(".tool.summary")).toHaveCount(4);
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

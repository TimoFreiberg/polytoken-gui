import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

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

test("renders the greeting conversation: user, assistant, tool card", async ({
  page,
}) => {
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(
    page.getByText("I'll add a lightweight health endpoint"),
  ).toBeVisible();
  await expect(page.getByText("Run shell command")).toBeVisible();
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
  await page.getByText("Run shell command").click();
  await expect(page.getByText("server/src/index.ts:14")).toBeVisible();
});

test("tool card expands to show the full arguments", async ({ page }) => {
  await page.getByText("Run shell command").click();
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

// Regression: scrolling up through history must not move the viewport on its own.
// Cause was CSS `content-visibility: auto` + an estimated `contain-intrinsic-size`
// on transcript rows — off-screen rows stood in at a 120px placeholder, then snapped
// to their (taller) real height as you scrolled up, injecting height above the
// viewport and drifting it downward. Removing CV renders every row at its true height
// up front, so nothing realizes mid-scroll.
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

import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const ta = ".composer-wrap textarea";

/** Read the textarea's box metrics in one round-trip. */
function metrics(page: import("@playwright/test").Page) {
  return page.$eval(ta, (el) => {
    const t = el as HTMLTextAreaElement;
    return {
      clientH: t.clientHeight,
      scrollH: t.scrollHeight,
      clientW: t.clientWidth,
      scrollW: t.scrollWidth,
    };
  });
}

test("composer: never scrolls horizontally, even with a long unbroken token", async ({
  page,
}) => {
  await page.fill(
    ta,
    "https://example.com/a/really/long/unbroken/path/" + "x".repeat(200),
  );
  const m = await metrics(page);
  // Text wraps; horizontal scroll must never appear (overflow-x: hidden).
  expect(m.scrollW).toBeLessThanOrEqual(m.clientW + 1);
});

test("composer: grows with lines, then caps with a vertical scrollbar", async ({
  page,
}) => {
  const empty = await metrics(page);

  // Three lines fit under the cap → grows, no vertical scrollbar yet.
  await page.fill(ta, "one\ntwo\nthree");
  const three = await metrics(page);
  expect(three.clientH).toBeGreaterThan(empty.clientH);
  expect(three.scrollH).toBeLessThanOrEqual(three.clientH + 1);

  // Far past the cap → height stops growing and a vertical scrollbar appears.
  await page.fill(
    ta,
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
  );
  const many = await metrics(page);
  expect(many.scrollH).toBeGreaterThan(many.clientH + 10);
  // Collapsed cap on the 850px-tall desktop viewport is ~168px (≈6.5 lines),
  // well under "eats the screen".
  expect(many.clientH).toBeLessThanOrEqual(180);
  expect(many.scrollW).toBeLessThanOrEqual(many.clientW + 1);
});

test("composer: expand toggle grows the cap and carries a tooltip", async ({
  page,
}) => {
  await page.fill(
    ta,
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
  );
  const collapsed = await metrics(page);

  const expand = page.locator(".composer-wrap .expand");
  await expect(expand).toHaveAttribute("title", "Expand composer (⌥⇧↑)");

  await expand.click();
  await expect
    .poll(async () => (await metrics(page)).clientH)
    .toBeGreaterThan(collapsed.clientH + 50);

  // Collapsing restores the lower cap; tooltip flips too.
  await expect(expand).toHaveAttribute("title", "Collapse composer (⌥⇧↓)");
  await expand.click();
  await expect
    .poll(async () => (await metrics(page)).clientH)
    .toBeLessThanOrEqual(collapsed.clientH + 1);
});

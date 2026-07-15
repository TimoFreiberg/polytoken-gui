import { expect, test, type Locator } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

type BoxMetrics = {
  clientHeight: number;
  scrollHeight: number;
  padding: [number, number, number, number];
  scrollbarColor: string;
  scrollbarWidth: string;
};

async function boxMetrics(locator: Locator): Promise<BoxMetrics> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      padding: [
        parseFloat(style.paddingTop),
        parseFloat(style.paddingRight),
        parseFloat(style.paddingBottom),
        parseFloat(style.paddingLeft),
      ],
      scrollbarColor: style.scrollbarColor,
      scrollbarWidth: style.scrollbarWidth,
    };
  });
}

async function stripeStyle(handle: Locator): Promise<{
  background: string;
  width: number;
}> {
  return handle.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return {
      background: style.backgroundColor,
      width: parseFloat(style.width),
    };
  });
}

function expectTransparent(color: string): void {
  expect(color).toMatch(/^(transparent|rgba\([^)]*,\s*0\))$/);
}

function expectPainted(color: string): void {
  expect(color).not.toMatch(/^(transparent|rgba\([^)]*,\s*0\))$/);
}

async function height(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().height);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 320 });
  await gotoFresh(page);
});

test("short desktop rails share their surface and retain compact scrolling geometry", async ({
  page,
}) => {
  await drive(page, "context");

  const leftRail = page.getByTestId("sidebar");
  const rightRail = page.getByTestId("right-sidebar");
  const [leftBackground, rightBackground] = await Promise.all([
    leftRail.evaluate((element) => getComputedStyle(element).backgroundColor),
    rightRail.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(leftBackground).toBe(rightBackground);

  const leftScroller = leftRail.locator(".list");
  const rightScroller = rightRail.locator(".content");
  const [left, right] = await Promise.all([
    boxMetrics(leftScroller),
    boxMetrics(rightScroller),
  ]);

  for (const metrics of [left, right]) {
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollbarWidth).toBe("thin");
    expect(metrics.scrollbarColor).toContain("rgba(0, 0, 0, 0)");
  }

  // Both rails keep a compact but non-zero content gutter without relying on a hard
  // divider. Use ranges so token refinements do not make this a screenshot test.
  expect(left.padding[3]).toBeGreaterThanOrEqual(6);
  expect(left.padding[3]).toBeLessThanOrEqual(12);
  const sectionPadding = await rightRail
    .locator(".section")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
    });
  for (const value of sectionPadding) {
    expect(value).toBeGreaterThanOrEqual(12);
    expect(value).toBeLessThanOrEqual(20);
  }

  const projectHeight = await height(leftRail.locator(".group-toggle").first());
  const rowHeight = await height(leftRail.locator(".row").first());
  for (const value of [projectHeight, rowHeight]) {
    expect(value).toBeGreaterThanOrEqual(30);
    expect(value).toBeLessThanOrEqual(36);
  }
  expect(Math.abs(projectHeight - rowHeight)).toBeLessThanOrEqual(4);
});

test("resize handles paint a centered stripe for focus and drag feedback", async ({
  page,
}) => {
  const handles = [
    page.getByRole("separator", { name: "Resize sessions sidebar" }),
    page.getByRole("separator", { name: "Resize context panel" }),
  ];

  for (const handle of handles) {
    const resting = await stripeStyle(handle);
    expect(resting.width).toBeGreaterThanOrEqual(1);
    expect(resting.width).toBeLessThanOrEqual(2);
    expectTransparent(resting.background);

    await handle.focus();
    await expect
      .poll(async () => (await stripeStyle(handle)).background)
      .not.toBe(resting.background);
    expectPainted((await stripeStyle(handle)).background);
  }

  const handle = handles[0]!;
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 120);
  await page.mouse.down();
  await expect(handle).toHaveClass(/\bdragging\b/);
  expectPainted((await stripeStyle(handle)).background);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.cursor))
    .toBe("col-resize");
  await page.mouse.up();
  await expect(handle).not.toHaveClass(/\bdragging\b/);
});

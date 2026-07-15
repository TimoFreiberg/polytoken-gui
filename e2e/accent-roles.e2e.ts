import { expect, test, type Locator, type Page } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function resolvedToken(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function contrastRatio(
  foreground: Locator,
  background: Locator,
): Promise<number> {
  const [fg, bg] = await Promise.all([
    foreground.evaluate((el) => getComputedStyle(el).color),
    background.evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  const rgb = (color: string): number[] =>
    color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number) ?? [0, 0, 0];
  const luminance = (color: string): number => {
    const channels = rgb(color).map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (
      0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    );
  };
  const [lighter, darker] = [luminance(fg), luminance(bg)].sort(
    (a, b) => b - a,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

test("gold actions stay distinct from nickel structure in both themes", async ({
  page,
}) => {
  await drive(page, "confirm");
  const primary = page.locator(".btn.primary").first();
  await expect(primary).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page
      .locator("html")
      .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
    const [accent, highlight, highlightText] = await Promise.all([
      resolvedToken(page, "--accent"),
      resolvedToken(page, "--highlight"),
      resolvedToken(page, "--highlight-text"),
    ]);

    expect(highlight).not.toBe(accent);
    await expect(primary).toHaveCSS("background-color", highlight);
    await expect(primary).toHaveCSS("color", highlightText);
    expect(await contrastRatio(primary, primary)).toBeGreaterThanOrEqual(4.5);
  }
});

test("working and ready states combine gold attention with nickel progress", async ({
  page,
}) => {
  await drive(page, "staleidle");
  const working = page.getByTestId("working-indicator");
  await expect(working).toBeVisible();
  await expect(working.locator(".coin")).toHaveCSS(
    "color",
    await resolvedToken(page, "--highlight"),
  );
  await expect(working.locator(".dot")).toHaveCSS(
    "background-color",
    await resolvedToken(page, "--accent"),
  );

  await gotoFresh(page);
  await openSidebar(page);
  const row = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await drive(page, "bgrun");
  await expect(row.getByTestId("session-status")).toHaveAttribute(
    "data-state",
    "done",
  );
  await expect(row.locator(".attention-symbol")).toHaveCSS(
    "color",
    await resolvedToken(page, "--highlight"),
  );
});

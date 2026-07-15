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

function rgb(color: string): number[] {
  return (
    color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number) ?? [0, 0, 0]
  );
}

function luminance(color: string): number {
  const channels = rgb(color).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function colorContrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

async function contrastRatio(
  foreground: Locator,
  background: Locator,
): Promise<number> {
  const [fg, bg] = await Promise.all([
    foreground.evaluate((el) => getComputedStyle(el).color),
    background.evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  return colorContrast(fg, bg);
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

test("paper, nickel, and prompt surfaces keep a visible hierarchy", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const prompt = page.locator(".row.user .bubble").first();
  const composer = page.locator(".composer-surface");
  await expect(prompt).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page
      .locator("html")
      .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
    const [
      canvas,
      sidebarSurface,
      promptSurface,
      cardSurface,
      strongBorder,
      mutedText,
    ] = await Promise.all([
      resolvedToken(page, "--bg"),
      resolvedToken(page, "--sidebar-bg"),
      resolvedToken(page, "--prompt-bg"),
      resolvedToken(page, "--surface"),
      resolvedToken(page, "--border-strong"),
      resolvedToken(page, "--text-muted"),
    ]);

    await expect(page.locator("body")).toHaveCSS("background-color", canvas);
    await expect(sidebar).toHaveCSS("background-color", sidebarSurface);
    await expect(prompt).toHaveCSS("background-color", promptSurface);
    await expect(prompt).toHaveCSS("border-color", strongBorder);
    await expect(composer).toHaveCSS("background-color", cardSurface);
    expect(colorContrast(mutedText, sidebarSurface)).toBeGreaterThanOrEqual(
      4.5,
    );
    const ordered =
      theme === "light"
        ? [cardSurface, canvas, sidebarSurface, promptSurface]
        : [promptSurface, cardSurface, sidebarSurface, canvas];
    const lightness = ordered.map(luminance);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i - 1]!).toBeGreaterThan(lightness[i]!);
      // Surface steps are deliberately subtle, but every adjacent material must retain
      // at least a 1.05:1 luminance contrast instead of merely using unequal hex values.
      expect(
        colorContrast(ordered[i - 1]!, ordered[i]!),
      ).toBeGreaterThanOrEqual(1.05);
    }
  }
});

test("working indicator is visible and ready states keep gold attention distinct", async ({
  page,
}) => {
  await drive(page, "staleidle");
  const working = page.getByTestId("working-indicator");
  await expect(working).toBeVisible();

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

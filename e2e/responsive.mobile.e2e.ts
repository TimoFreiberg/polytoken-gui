import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Runs under the "mobile" project (iPhone 13 viewport).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("transcript and composer fit the mobile viewport", async ({ page }) => {
  await expect(
    page.getByText("Add a /health route to the server"),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Message pantoken…")).toBeVisible();
});

test("approval sheet is reachable and tappable on mobile", async ({ page }) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Run destructive command?")).toBeVisible();
  const allow = dialog.getByRole("button", { name: "Allow" });
  await expect(allow).toBeInViewport();
  await allow.click();
  await expect(page.getByText("Approved — continuing.")).toBeVisible();
});

test("a wide markdown table scrolls horizontally instead of overflowing", async ({
  page,
}) => {
  await drive(page, "markdown");
  const md = page.locator(".markstream-svelte.markdown-renderer").last();
  // The fixture renders a narrow table, then a 7-column "wide table", then a code
  // block. Wait for the code block (last in the stream) so the whole turn — and the
  // wide table — has finished streaming before we measure.
  await expect(md.locator("pre", { hasText: "function greet" })).toBeVisible();
  // Select the wide table by a header unique to it (not `.last()`, which would race
  // the stream — the narrow table renders first).
  const wide = md.locator("table", { hasText: "CallingCode" });
  await expect(wide).toBeVisible();
  // The row carries `content-visibility: auto`; an off-screen row isn't laid out,
  // so measure only after scrolling it on-screen (a plain assertion won't scroll).
  await wide.scrollIntoViewIfNeeded();
  const metrics = await wide.evaluate((t) => ({
    overflowX: getComputedStyle(t).overflowX,
    // content is wider than the box → it's an actual horizontal scroll container
    scrolls: t.scrollWidth > t.clientWidth + 1,
    // the element itself stays within the viewport (no page-level overflow)
    rightWithinViewport:
      t.getBoundingClientRect().right <= window.innerWidth + 1,
    noPageOverflow:
      document.documentElement.scrollWidth <= window.innerWidth + 1,
  }));
  expect(metrics.overflowX).toBe("auto");
  expect(metrics.scrolls).toBe(true);
  expect(metrics.rightWithinViewport).toBe(true);
  expect(metrics.noPageOverflow).toBe(true);

  // On a coarse pointer the overlay scrollbar hides at rest, so the container carries the
  // "scrolling shadows" fade (4 gradient layers: 2 edge covers + 2 shadows) to hint the
  // cut-off columns. Desktop, with a persistent scrollbar, doesn't get this.
  const fade = await wide.evaluate((t) => {
    const cs = getComputedStyle(t);
    return {
      gradients: (cs.backgroundImage.match(/gradient/g) || []).length,
      hasLocal: cs.backgroundAttachment.includes("local"),
    };
  });
  expect(fade.gradients).toBe(4);
  expect(fade.hasLocal).toBe(true);
});

test("text inputs render at >=16px on touch (guards against iOS focus-zoom)", async ({
  page,
}) => {
  // iOS Safari auto-zooms the page when you focus a form control whose font-size is
  // < 16px, and won't zoom back out. The global `@media (pointer: coarse)` rule forces
  // every input to 16px. Assert it actually reaches a real input — the sidebar search,
  // which is 13px on desktop — under this hasTouch (pointer: coarse) project.
  await openSidebar(page);
  const search = page.getByRole("textbox", { name: "Search sessions" });
  await expect(search).toBeVisible();
  const fontSize = await search.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  expect(fontSize).toBeGreaterThanOrEqual(16);
});

test("the per-turn copy button stays visible on touch (no hover to reveal it)", async ({
  page,
}) => {
  // The greeting's final assistant paragraph carries the copy footer. On desktop it's
  // hover-revealed (opacity 0 at rest); a touch device has no hover, so it must be
  // pinned visible. Gated on a JS capability check (maxTouchPoints), so this mobile
  // project (hasTouch) shows it while the desktop project keeps the hover-reveal.
  await expect(
    page.getByText("Routes live in", { exact: false }),
  ).toBeVisible();
  const copy = page.locator(".copy").last();
  await expect(copy).toBeVisible();
  await expect(copy).toHaveCSS("opacity", "1");
});

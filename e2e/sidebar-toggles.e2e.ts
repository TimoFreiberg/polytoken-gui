import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The header hamburgers (sidebar-toggle / context-toggle) were removed, and so were the
// mid-edge pop-in tabs that replaced them; a collapsed sidebar now reopens from a panel
// icon in the header's own top row (StatusHeader) or its hotkey (⌘B / ⌘⇧J). Both sidebars
// default OPEN on desktop, so these tests collapse one first via its own in-panel control,
// then exercise the header panel icon.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the header hamburgers are gone", async ({ page }) => {
  await expect(page.getByTestId("sidebar-toggle")).toHaveCount(0);
  await expect(page.getByTestId("context-toggle")).toHaveCount(0);
});

test("both sidebars are visible by default on desktop", async ({ page }) => {
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
});

test("collapsing the left sidebar reveals a header panel icon that reopens it", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  const open = page.getByTestId("sidebar-open");

  await expect(open).toHaveCount(0);
  // The panel icon is wrapped in a span (not a direct child of .icon-btn), so it
  // keeps its explicit size and isn't expanded to the button's inherited font-size.
  // AC.1: the left-sidebar collapse button shows a panel-left icon (divider at x=9).
  const collapseIcon = collapse.locator("svg");
  await expect(collapseIcon).toHaveAttribute("width", "15");
  await expect(collapseIcon).toHaveCSS("width", "15px");
  await expect(collapse.locator("line")).toHaveAttribute("x1", "9");
  const collapseBox = await collapse.boundingBox();
  await collapse.click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("title", /^Show sessions/);
  // AC.2: the "Show sessions" reopen button shows a panel-left icon (divider at x=9).
  await expect(open.locator("line")).toHaveAttribute("x1", "9");

  // The sidebar's collapse toggle sits at its trailing edge, so this one can't share
  // its x — but it shares the top row, which is what makes collapse/expand a click
  // back and forth near the same corner rather than a hunt down the screen edge.
  const openBox = await open.boundingBox();
  expect(collapseBox).not.toBeNull();
  expect(openBox).not.toBeNull();
  expect(Math.abs(openBox!.y - collapseBox!.y)).toBeLessThanOrEqual(1);

  await open.click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  // The toggle itself disappears again once its sidebar is open.
  await expect(open).toHaveCount(0);
});

test("collapsing the context panel reveals a header panel icon that reopens it, in place", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  const collapse = page.getByRole("button", { name: "Collapse context panel" });
  const open = page.getByTestId("context-open");

  await expect(open).toHaveCount(0);
  // AC.3 (desktop): the right-sidebar collapse button shows a panel-right icon
  // (divider at x=15).
  await expect(collapse.locator("line")).toHaveAttribute("x1", "15");
  const collapseBox = await collapse.boundingBox();
  await collapse.click();
  await expect(panel).toHaveAttribute("data-open", "false");

  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("data-tip-title", /^Show context panel/);
  // AC.5 (desktop): the entry shows even at context count 0 (no badge).
  await expect(open.getByTestId("context-badge")).toHaveCount(0);
  // AC.4 (desktop): the context-open reopen button shows a panel-right icon (x=15).
  await expect(open.locator(".chevron-desktop line")).toHaveAttribute("x1", "15");
  // AC.6: the desktop icon wrapper is not mirrored (no scaleX(-1) transform).
  await expect(open.locator(".chevron-desktop")).not.toHaveCSS(
    "transform",
    /matrix/,
  );

  // Same pixel as the collapse control it replaced — so collapse/expand/collapse
  // is a repeatable click on one spot, not a hunt for a mid-edge tab.
  const openBox = await open.boundingBox();
  expect(collapseBox).not.toBeNull();
  expect(openBox).not.toBeNull();
  expect(Math.abs(openBox!.x - collapseBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(openBox!.y - collapseBox!.y)).toBeLessThanOrEqual(1);

  await open.click();
  await expect(panel).toHaveAttribute("data-open", "true");
  await expect(open).toHaveCount(0);
});

test("a collapsed left sidebar stays collapsed across a reload", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );

  await gotoFresh(page);

  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
  // Restore it so this test doesn't leak a closed default into anything reading
  // localStorage after it (each test gets its own context, but be tidy regardless).
  await page.getByTestId("sidebar-open").click();
});

test("a collapsed context panel stays collapsed across a reload", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );

  await gotoFresh(page);

  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
});

test("⌘B and ⌘⇧J still reopen a collapsed sidebar without the header buttons", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const panel = page.getByTestId("right-sidebar");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.getByRole("button", { name: "Collapse context panel" }).click();
  await expect(sidebar).toHaveAttribute("data-open", "false");
  await expect(panel).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "true");

  await page.keyboard.press("Control+Shift+j");
  await expect(panel).toHaveAttribute("data-open", "true");
});

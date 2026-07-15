import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The header hamburgers (sidebar-toggle / context-toggle) were removed, and so were the
// mid-edge pop-in tabs that replaced them; a collapsed sidebar now reopens from a chevron
// in the header's own top row (StatusHeader) or its hotkey (⌘B / ⌘⇧J). Both sidebars
// default OPEN on desktop, so these tests collapse one first via its own in-panel control,
// then exercise the header chevron.

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

test("collapsing the left sidebar reveals a header arrow that reopens it", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  const open = page.getByTestId("sidebar-open");

  await expect(open).toHaveCount(0);
  // IconButton normalizes raw SVG children, but a nested Chevron owns its explicit
  // size and must not be expanded to the button's inherited icon font-size.
  const collapseChevron = collapse.locator(".chevron svg");
  await expect(collapseChevron).toHaveAttribute("width", "11");
  await expect(collapseChevron).toHaveCSS("width", "11px");
  const collapseBox = await collapse.boundingBox();
  await collapse.click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("title", /^Show sessions/);

  // The sidebar's collapse chevron sits at its trailing edge, so this one can't share
  // its x — but it shares the top row, which is what makes collapse/expand a click
  // back and forth near the same corner rather than a hunt down the screen edge.
  const openBox = await open.boundingBox();
  expect(collapseBox).not.toBeNull();
  expect(openBox).not.toBeNull();
  expect(Math.abs(openBox!.y - collapseBox!.y)).toBeLessThanOrEqual(1);

  await open.click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  // The arrow itself disappears again once its sidebar is open.
  await expect(open).toHaveCount(0);
});

test("collapsing the context panel reveals a header arrow that reopens it, in place", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  const collapse = page.getByRole("button", { name: "Collapse context panel" });
  const open = page.getByTestId("context-open");

  await expect(open).toHaveCount(0);
  const collapseBox = await collapse.boundingBox();
  await collapse.click();
  await expect(panel).toHaveAttribute("data-open", "false");

  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("title", /^Show context panel/);

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

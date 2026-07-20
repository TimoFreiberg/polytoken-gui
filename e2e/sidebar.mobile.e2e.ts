import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Runs under the "mobile" project (Pixel 7 viewport).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("opening the drawer does NOT focus the search box on a phone", async ({
  page,
}) => {
  // Focus-on-open is desktop-only: on a phone it would pop the soft keyboard on every
  // open. Opening the drawer (a closed→open transition) must leave the search unfocused.
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.getByTestId("sidebar-search-toggle")).toBeVisible();
  await expect(sidebar.getByTestId("sidebar-search-input")).toHaveCount(0);
  await sidebar.getByTestId("sidebar-search-toggle").click();
  const search = sidebar.getByTestId("sidebar-search-input");
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
});

// Both drawers default CLOSED on a phone (overlay semantics, unchanged); the header
// hamburgers that used to open them are gone, so the header panel icon (or the
// left-edge swipe, for the sessions drawer — see edge-swipe.mobile.e2e.ts) is now the
// only tap affordance besides ⌘B / ⌘⇧J (which a soft keyboard doesn't offer anyway).

test("the sessions drawer is closed by default on a phone, with a header panel icon to open it", async ({
  page,
}) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  const edgeOpen = page.getByTestId("sidebar-open");
  await expect(edgeOpen).toBeVisible();
  await edgeOpen.click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
});

test("the context panel is closed by default and reachable from the header", async ({
  page,
}) => {
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "false");

  // The header context entry is always visible (no badge at count 0).
  const open = page.getByTestId("context-open");
  await expect(open).toBeVisible();
  await open.click();
  await expect(panel).toHaveAttribute("data-open", "true");
  // AC.3 (mobile): the right-sidebar collapse button shows a panel-right icon (x=15).
  const collapse = panel.getByRole("button", { name: "Collapse context panel" });
  await expect(collapse.locator("line")).toHaveAttribute("x1", "15");
  // AC.7: the mobile collapse glyph is not mirrored (no scaleX(-1) transform).
  await expect(collapse.locator(".collapse-glyph")).not.toHaveCSS(
    "transform",
    /matrix/,
  );
  // The collapse control ("Collapse context panel") and the scrim
  // ("Close context panel", tap-outside-to-dismiss) carry distinct labels;
  // scoping keeps the control lookup local to the drawer.
  await collapse.click();
  await expect(panel).toHaveAttribute("data-open", "false");
  await page.getByTestId("context-open").click();
  await expect(panel).toHaveAttribute("data-open", "true");
});

test("the header context entry shows a panel-right icon and count badge on a phone", async ({
  page,
}) => {
  // The context fixture: 3 flagged files + 3 jobs + 3 todos = 9 context items.
  await drive(page, "context");
  const open = page.getByTestId("context-open");
  await expect(open).toBeVisible();
  // AC.4 (mobile): the ctx-glyph shows a panel-right icon (x=15) + a visible badge.
  await expect(open.locator(".ctx-glyph line")).toHaveAttribute("x1", "15");
  const badge = open.getByTestId("context-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("9");
});

test("the last-activity timestamp is always visible beside the ⋯ on a phone (no hover)", async ({
  page,
}) => {
  // AC.3 — On mobile (≤859px) the timestamp stays always-visible beside the
  // always-visible ⋯ button, matching the pre-change behavior. No hover available
  // on touch, so the desktop hover-reveal must be reset to opacity:1 here.
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const demoRow = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket" });
  const time = demoRow.locator(".row-time");
  // Visible without hovering, and at full opacity (not the desktop default of 0).
  await expect(time).toBeVisible();
  await expect(time).toHaveCSS("opacity", "1");
  await expect(time).toHaveText(/^\d+(m|h|d|w|mo|y)$/);
});

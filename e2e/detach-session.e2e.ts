import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// AC.1 — the sidebar session right-click menu shows a "Detach session" item
// with a D hotkey badge and a tooltip explaining its purpose.
test("the overflow menu shows a detach session item with a D hotkey", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await row.hover();
  await row.getByTestId("session-menu").click();

  const item = sidebar.getByTestId("detach-session");
  await expect(item).toBeVisible();
  await expect(item).toContainText("Detach session");
  await expect(item.locator("kbd.hotkey")).toHaveText("D");
  await expect(item).toHaveAttribute(
    "title",
    /Release Pantoken's attachment lease/,
  );
});

// AC.5 — the mock driver's detach_session is a no-op (trait default → Ok(())),
// so clicking it must not produce a toast or error.
test("clicking detach session on the mock is a no-op (no error)", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  await sidebar.getByTestId("detach-session").click();

  // No toast appears (the mock's detach is a no-op that returns Ok).
  await expect(page.getByTestId("toast")).toHaveCount(0);
  // The menu closes after clicking.
  await expect(sidebar.getByTestId("detach-session")).toHaveCount(0);
});

// AC.6 — the D keyboard shortcut triggers detach when the menu is open and
// focus is not in a text field.
test("the D hotkey triggers detach from the menu", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await row.hover();
  await row.getByTestId("session-menu").click();
  // The menu is open; pressing D fires the detach handler (which closes the menu).
  await page.keyboard.press("d");

  // The menu closed — the handler fired.
  await expect(sidebar.getByTestId("detach-session")).toHaveCount(0);
});

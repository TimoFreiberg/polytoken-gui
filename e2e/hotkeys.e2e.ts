import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// CI runs Chromium on Linux, where the app's hotkeys read Ctrl (the handler accepts
// metaKey || ctrlKey), so the presses use "Control+…" to match the other specs.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");
const title = (page: Page) => page.locator("header .title");
function row(page: Page, name: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: name });
}

test("⌘N opens a new-session draft in the current project", async ({
  page,
}) => {
  // Boot lands on the bridge session (project "pilot"); no draft yet.
  await expect(draftBox(page)).toBeHidden();

  await page.keyboard.press("Control+n");

  await expect(draftBox(page)).toBeVisible();
  await expect(title(page)).toHaveText("New session");
  // The draft defaults to the focused session's project (pilot).
  await expect(page.locator("header .sub .path")).toHaveText("pilot");
});

test("⌘[ and ⌘] step back and forward through visited sessions", async ({
  page,
}) => {
  await openSidebar(page);
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Visit a second session.
  await row(page, "Explore the fold reducer").click();
  await expect(title(page)).toContainText("Explore the fold reducer");

  // Back → the bridge session.
  await page.keyboard.press("Control+[");
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Forward → the fold-reducer session again.
  await page.keyboard.press("Control+]");
  await expect(title(page)).toContainText("Explore the fold reducer");
});

test("back history reaches a new-session draft", async ({ page }) => {
  await openSidebar(page);
  // session → draft, then back lands on the session again.
  await page.keyboard.press("Control+n");
  await expect(draftBox(page)).toBeVisible();

  await page.keyboard.press("Control+[");
  await expect(draftBox(page)).toBeHidden();
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  await page.keyboard.press("Control+]");
  await expect(title(page)).toHaveText("New session");
});

test("Ctrl+Tab / Ctrl+Shift+Tab cycle through sessions in sidebar order", async ({
  page,
}) => {
  // Boot lands on the active row. Sidebar order: project groups A→Z (pilot, scratch),
  // newest-first within a group — so "Wire up…" → "Explore…" → the scratch session.
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Explore the fold reducer");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("scratch");

  // Past the last row wraps back to the top.
  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Shift reverses, and wraps off the top to the last row.
  await page.keyboard.press("Control+Shift+Tab");
  await expect(title(page)).toContainText("scratch");

  await page.keyboard.press("Control+Shift+Tab");
  await expect(title(page)).toContainText("Explore the fold reducer");
});

test("⌘B toggles the sidebar", async ({ page }) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "true"); // desktop default

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "true");
});

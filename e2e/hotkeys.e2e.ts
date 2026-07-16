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
  // Boot lands on the bridge session (project "pantoken"); no draft yet.
  await expect(draftBox(page)).toBeHidden();

  await page.keyboard.press("Control+n");

  await expect(draftBox(page)).toBeVisible();
  await expect(title(page)).toHaveText("New session");
  // The draft defaults to the focused session's project (pantoken).
  await expect(page.locator("header .sub .path")).toHaveText("pantoken");
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

test("window.__pantokenNav steps back and forward like ⌘[ / ⌘]", async ({
  page,
}) => {
  await openSidebar(page);
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Visit a second session.
  await row(page, "Explore the fold reducer").click();
  await expect(title(page)).toContainText("Explore the fold reducer");

  // Use a local cast (same pattern as __pantokenMock in e2e/live/helpers.ts)
  // so tsc doesn't complain about the missing Window property.
  await page.evaluate(() => {
    const w = window as unknown as {
      __pantokenNav?: (dir: "back" | "forward") => void;
    };
    w.__pantokenNav?.("back");
  });
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  await page.evaluate(() => {
    const w = window as unknown as {
      __pantokenNav?: (dir: "back" | "forward") => void;
    };
    w.__pantokenNav?.("forward");
  });
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
  // Boot lands on the active row. Sidebar order: project groups A→Z (pantoken,
  // retry-lib, scratch), newest-first within a group — so "Wire up…" → "Explore…" →
  // the cold-restore regression fixture (mock_driver.rs's own distinct-cwd group,
  // added for the cold-restore collapse bug, docs/TODO.md) → the scratch session.
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Explore the fold reducer");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Cold-restore regression check");

  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("scratch");

  // Past the last row wraps back to the top.
  await page.keyboard.press("Control+Tab");
  await expect(title(page)).toContainText("Wire up the WebSocket bridge");

  // Shift reverses, and wraps off the top to the last row.
  await page.keyboard.press("Control+Shift+Tab");
  await expect(title(page)).toContainText("scratch");

  await page.keyboard.press("Control+Shift+Tab");
  await expect(title(page)).toContainText("Cold-restore regression check");
});

test("⌘B toggles the sidebar", async ({ page }) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-open", "true"); // desktop default

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-open", "true");
});

test("⌘K focuses the sidebar session search", async ({ page }) => {
  // The sidebar is open by default on desktop. ⌘K should open the search
  // overlay and focus the input.
  await page.keyboard.press("Control+k");

  const input = page.getByTestId("sidebar-search-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
});

test("⌘K opens the sidebar first if collapsed, then focuses search", async ({
  page,
}) => {
  // Collapse the sidebar.
  await page.keyboard.press("Control+b");
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );

  // ⌘K should reopen the sidebar and focus the search.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
  const input = page.getByTestId("sidebar-search-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
});

test("⌘⇧J toggles the context panel", async ({ page }) => {
  const panel = page.getByTestId("right-sidebar");
  await expect(panel).toHaveAttribute("data-open", "true"); // desktop default

  await page.keyboard.press("Control+Shift+j");
  await expect(panel).toHaveAttribute("data-open", "false");

  await page.keyboard.press("Control+Shift+j");
  await expect(panel).toHaveAttribute("data-open", "true");
});

test("the status header has a Tauri drag region covering its whole non-interactive surface", async ({
  page,
}) => {
  // The Tauri shell uses TitleBarStyle::Overlay (chromeless). "deep" (not a bare
  // attribute) is required so a click anywhere in the header's non-interactive area —
  // not just the literal <header> element itself — starts a drag; Tauri's own
  // clickable-element heuristic still exempts real buttons (bell, plan/settings
  // toggles) without any per-element opt-out. The attribute is inert in a browser
  // (unknown data-* attr), so this just asserts its value — the actual drag behavior
  // (and the desktop shell's IPC grant for it, see desktop/capabilities/window-drag.json)
  // is desktop-only and needs a human dogfood pass.
  const header = page.locator("header.hdr");
  await expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
});

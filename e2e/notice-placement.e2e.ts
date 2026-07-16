import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Validate that notices render on the correct scoped surface: sidebar-scoped
// notices (archive undo) appear inside the sidebar element and are in-flow (not
// position:fixed), while chat-scoped notices (stop errors) appear in the chat
// area and NOT inside the sidebar.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("archive undo notice appears inside the sidebar, not as a fixed overlay", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Archive a session via the context menu.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();
  await row.locator(".row").click({ button: "right" });
  await sidebar.getByRole("menuitem", { name: "Archive", exact: true }).click();

  // The undo notice appears inside the sidebar element.
  const notice = sidebar.getByTestId("toast").filter({ hasText: "Archived" });
  await expect(notice).toBeVisible();

  // It is in-flow (an ancestor is the sidebar, not a fixed-position overlay).
  // Check that the notice's computed position is not 'fixed'.
  const position = await notice.evaluate((el) =>
    window.getComputedStyle(el).getPropertyValue("position"),
  );
  expect(position).not.toBe("fixed");

  // The notice is inside the sidebar-notice container, not the chat-notice container.
  await expect(
    page.getByTestId("sidebar-notice").getByTestId("toast"),
  ).toHaveCount(1);
  await expect(page.getByTestId("chat-notice")).toHaveCount(0);
});

test("stop unconfirmed state appears on the stop button, not as a chat notice or sidebar error", async ({
  page,
}) => {
  // Trigger a stop no-response timeout (the slowabort script delays the
  // entire abort() by 1000ms, so the 500ms timer fires first).
  await drive(page, "slowabort");
  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await stop.click();

  // The stop button shows the retry state.
  await expect(stop).toHaveText("↻ Retry stop", { timeout: 1_500 });

  // No chat notice appears — the unconfirmed state is consolidated to the
  // stop button only.
  await expect(
    page.getByTestId("chat-notice").getByTestId("toast"),
  ).toHaveCount(0);

  // No sidebar error either.
  await expect(page.getByTestId("sidebar").getByTestId("toast")).toHaveCount(0);
});

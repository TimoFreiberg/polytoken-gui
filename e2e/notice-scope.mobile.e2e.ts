import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Mobile-only: when the sidebar is closed and a sidebar-scoped notice exists,
// the sidebar-open control shows an unread badge. Sidebar and chat notices stay
// on their own surfaces (no duplication).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("sidebar notice shows an unread badge when the sidebar is closed", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Archive a session — this creates a sidebar-scoped notice.
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(row).toBeVisible();
  await row.getByTestId("session-menu").click();
  await page
    .getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();

  // The notice is visible inside the sidebar.
  await expect(
    sidebar.getByTestId("toast").filter({ hasText: "Archived" }),
  ).toBeVisible();

  // Close the sidebar (phone drawer: the collapse toggle inside the sidebar closes it).
  await page
    .getByTestId("sidebar")
    .getByRole("button", { name: "Close sessions" })
    .click();
  await expect(sidebar).toHaveAttribute("data-open", "false");

  // The sidebar-open control now shows the unread badge.
  const badge = page.getByTestId("sidebar-notice-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("1");

  // Reopening the sidebar shows the notice.
  await page.getByTestId("sidebar-open").click();
  await expect(sidebar).toHaveAttribute("data-open", "true");
  await expect(
    sidebar.getByTestId("toast").filter({ hasText: "Archived" }),
  ).toBeVisible();
});

test("sidebar notices stay in the sidebar (no duplication to chat area)", async ({
  page,
}) => {
  // Open the sidebar and archive a session (sidebar-scoped notice).
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  const row = sidebar
    .locator(".row-wrap")
    .filter({ hasText: "Wire up the WebSocket bridge" });
  await expect(row).toBeVisible();
  await row.getByTestId("session-menu").click();
  await page
    .getByRole("dialog", { name: "Session actions" })
    .getByRole("button", { name: "Archive", exact: true })
    .click();

  // The sidebar notice is in the sidebar-notice container only.
  await expect(
    sidebar.getByTestId("toast").filter({ hasText: "Archived" }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("chat-notice")
      .getByTestId("toast")
      .filter({ hasText: "Archived" }),
  ).toHaveCount(0);
});

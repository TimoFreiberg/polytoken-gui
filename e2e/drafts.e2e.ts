import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const composer = (page: Page) => page.locator(".composer-wrap textarea");
function row(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}

test("a per-session draft survives switching away and back", async ({
  page,
}) => {
  await openSidebar(page);
  await composer(page).fill("notes for the bridge session");

  // Switch to another session — its (empty) draft replaces the text.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Back to the first session — the draft is restored.
  await row(page, "Wire up the WebSocket bridge").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("notes for the bridge session");
});

test("a per-session draft survives a reload", async ({ page }) => {
  await composer(page).fill("survive a reload");
  // pagehide on reload flushes the draft to localStorage; boot restores the focused
  // session's draft.
  await page.reload();
  await expect(composer(page)).toHaveValue("survive a reload");
});

test("a pending new-session draft is restored when you reopen the new view", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const draftBox = page.getByPlaceholder("Describe a task or ask a question…");
  await draftBox.fill("a brand-new idea");

  // Navigate to an existing session — exits the draft (composer reflects that session).
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the idea is still there.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toHaveValue("a brand-new idea");
});

test("sending a prompt clears its stored draft (no resurrection on return)", async ({
  page,
}) => {
  await openSidebar(page);
  const box = composer(page);
  await box.fill("ephemeral");
  await box.press("Enter");
  await expect(box).toHaveValue("");

  // Leave and come back — the sent draft must NOT reappear.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");
});

test("a new-session draft hides the focused session's tasklist pill", async ({
  page,
}) => {
  await drive(page, "ambient");
  const pill = page.getByRole("button", { name: /3 tasks/ });
  await expect(pill).toBeVisible();

  // Opening the new-session view is a client overlay over the focused session;
  // that session's tasklist must not bleed into the fresh draft (which has none).
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toBeVisible();
  await expect(pill).toBeHidden();
});

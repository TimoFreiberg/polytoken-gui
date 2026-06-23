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

test("a pending new-session draft's worktree toggle survives leaving and reopening", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  const worktree = page.getByRole("button", { name: "worktree" });
  await expect(worktree).toHaveAttribute("aria-pressed", "false");
  await worktree.click();
  await expect(worktree).toHaveAttribute("aria-pressed", "true");

  // Navigate to an existing session — exits the draft.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the toggle is still on.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByRole("button", { name: "worktree" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a pending new-session draft's worktree toggle survives a reload", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await page.getByRole("button", { name: "worktree" }).click();
  await page.reload();
  // Boot restores the focused session, not the draft, so reopen the new view.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(page.getByRole("button", { name: "worktree" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// Pick a non-default model (Sonnet — same anthropic group as the Opus default, which is
// seeded open) and a non-default thinking level (high), then assert the badges reflect it.
async function pickNonDefaultModelAndThinking(page: Page): Promise<void> {
  await page
    .locator(".mp .badge")
    .filter({ hasText: "Claude Opus 4.8" })
    .click();
  await page.locator(".mp .panel").getByText("Claude Sonnet 4.6").click();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "Claude Sonnet 4.6" }),
  ).toBeVisible();

  await page.locator(".mp .badge").filter({ hasText: "medium" }).click();
  await page.locator(".mp .item").filter({ hasText: "high" }).click();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
}

async function expectNonDefaultModelAndThinking(page: Page): Promise<void> {
  await expect(
    page.locator(".mp .badge").filter({ hasText: "Claude Sonnet 4.6" }),
  ).toBeVisible();
  await expect(
    page.locator(".mp .badge").filter({ hasText: "high" }),
  ).toBeVisible();
}

test("a pending new-session draft's model + thinking survive leaving and reopening", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await pickNonDefaultModelAndThinking(page);

  // Navigate to an existing session — exits the draft.
  await row(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(composer(page)).toHaveValue("");

  // Reopen the new-session view (same project) — the picks are still there.
  await page.getByRole("button", { name: "New session…" }).click();
  await expectNonDefaultModelAndThinking(page);
});

test("a pending new-session draft's model + thinking survive a reload", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await pickNonDefaultModelAndThinking(page);

  await page.reload();
  // Boot restores the focused session, not the draft, so reopen the new view.
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expectNonDefaultModelAndThinking(page);
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

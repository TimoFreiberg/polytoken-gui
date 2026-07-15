import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

/** The project group `<section>` whose header names `proj` (cwd basename). */
function group(page: Page, proj: string) {
  return page
    .getByTestId("sidebar")
    .locator("section.group")
    .filter({ has: page.locator(".proj", { hasText: proj }) });
}

function sessionRow(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}

/** Start a new-session draft targeting the named project's group via its "+" button. */
async function newDraftIn(page: Page, proj: string) {
  await page.getByRole("button", { name: `New session in ${proj}` }).click();
}

test("a draft nests under its project and survives navigating away", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("nest + persist");

  // While composing, the draft is the active row inside the pantoken group.
  const pantokenDraft = group(page, "pantoken").getByTestId("draft-row");
  await expect(pantokenDraft).toBeVisible();
  await expect(pantokenDraft).toHaveClass(/\bactive\b/);

  // Navigate to an existing session — the draft row stays put (now idle), it doesn't
  // vanish the moment you look away.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(pantokenDraft).toBeVisible();
  await expect(pantokenDraft).not.toHaveClass(/\bactive\b/);
});

test("opening a draft highlights only the draft — the previously focused session drops its highlight", async ({
  page,
}) => {
  // docs/TODO.md: "When the new session draft view is open in the sidebar both the
  // new session and the previously focused session are highlighted at once. Only the
  // 'new session' should be highlighted."
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // The greeting session is focused (and highlighted) before any draft opens.
  const focusedRow = sidebar.locator("button.row", {
    hasText: "Wire up the WebSocket bridge",
  });
  await expect(focusedRow).toHaveClass(/\bactive\b/);

  await newDraftIn(page, "pantoken");
  const draftRow = group(page, "pantoken").getByTestId("draft-row");
  await expect(draftRow).toHaveClass(/\bactive\b/);

  // The previously focused row is still visible, but plain — not highlighted...
  await expect(focusedRow).toBeVisible();
  await expect(focusedRow).not.toHaveClass(/\bactive\b/);
  // ...so the draft is the ONLY highlighted row in the whole sidebar.
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);

  // Canceling the draft (back to the focused session) restores its highlight.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(focusedRow).toHaveClass(/\bactive\b/);
  await expect(sidebar.locator("button.row.active")).toHaveCount(1);
});

test("the × discards a draft", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("discard me");

  const pantokenDraft = group(page, "pantoken").getByTestId("draft-row");
  await expect(pantokenDraft).toBeVisible();

  // Hover reveals the × on desktop; clicking it drops the draft entirely.
  await pantokenDraft.hover();
  await page
    .getByRole("button", { name: "Discard this new-session draft" })
    .click();
  await expect(page.getByTestId("draft-row")).toHaveCount(0);
});

test("retargeting a draft moves its row to the new project — no ghost left behind", async ({
  page,
}) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("moving");

  // Stash the draft under the pantoken key by navigating away, then reopen it. This is the
  // case migration must handle: a retarget now has a stale stashed copy to clean up.
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await group(page, "pantoken").getByTestId("draft-row").click();

  // Retarget via the project chip → dir picker.
  await page.getByTestId("draft-project-control").click();
  await expect(page.getByTestId("dir-picker")).toBeVisible();
  const picker = page.getByTestId("dir-picker");
  const input = picker.getByLabel("Project directory path");
  await input.fill("/Users/timo/src/scratch/");
  await expect(picker.getByTestId("use-current-directory")).toBeVisible();
  await picker.getByTestId("use-current-directory").click();

  // The row now lives under scratch, and pantoken has no leftover ghost row.
  await expect(group(page, "scratch").getByTestId("draft-row")).toBeVisible();
  await expect(group(page, "pantoken").getByTestId("draft-row")).toHaveCount(0);

  // Re-stash under the new key and confirm only scratch persists (the pantoken key was
  // migrated away, not duplicated).
  await sessionRow(page, "Explore the fold reducer").click();
  await openSidebar(page);
  await expect(group(page, "scratch").getByTestId("draft-row")).toBeVisible();
  await expect(group(page, "pantoken").getByTestId("draft-row")).toHaveCount(0);
});

test("a draft hides when its project group is collapsed", async ({ page }) => {
  await openSidebar(page);
  await newDraftIn(page, "pantoken");
  await draftBox(page).fill("hide me");

  const pantoken = group(page, "pantoken");
  await expect(pantoken.getByTestId("draft-row")).toBeVisible();

  // Collapsing the group hides the draft with it (the draft <li> rides the group's <ul>).
  await pantoken.locator(".group-toggle").click();
  await expect(pantoken.getByTestId("draft-row")).toBeHidden();
});

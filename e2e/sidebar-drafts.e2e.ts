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
  await page.locator('button.chip[title^="Project:"]').click();
  // Type the target path in the always-visible filter input. Starting with /
  // enters path mode; Enter navigates there, then "Use this folder" commits.
  const input = page.getByTestId("dir-picker").locator(".filter-input");
  await input.fill("/Users/timo/src/scratch");
  await input.press("Enter");
  // Commit the new project directory.
  await page.getByTestId("dir-picker").locator(".use").click();

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

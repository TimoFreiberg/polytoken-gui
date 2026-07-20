import { expect, test, type Page } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Issue #68: when a session running in a worktree is the viewed/active session and a
// new-session draft is opened, the draft's project directory must default to the
// parent project (the one the session is grouped under in the sidebar), never the
// worktree directory itself. The sidebar groups worktree sessions under
// `worktree.base` (the parent repo); the draft-prefill sites must agree.
//
// The mock's WORKSPACE_PATH is /Users/timo/src/pantoken, so:
//   - parent project basename = "pantoken"
//   - worktree dir            = /Users/timo/src/pantoken-worktree (basename "pantoken-worktree")
// The `worktree-session` mock script injects a session whose cwd is the worktree dir
// and whose WorktreeMeta.base is WORKSPACE_PATH, so list_sessions attaches WorktreeInfo
// and the sidebar groups it under "pantoken".

const PARENT_PROJECT = "/Users/timo/src/pantoken";
const PARENT_BASENAME = "pantoken";
const WORKTREE_BASENAME = "pantoken-worktree";

/** Drive a mock script via the `__pantokenMock` window hook (sends
 *  `{type:"mock", script}` over WS, bypassing the dev-bar scripts array). */
async function mockScript(page: Page, script: string): Promise<void> {
  await page.evaluate((s) => {
    (window as unknown as { __pantokenMock?: (script: string) => void }).__pantokenMock?.(
      s,
    );
  }, script);
}

/** The draft project chip — its visible text is the project basename, its title is
 *  `Project: <full path>`, and its aria-label starts with `<basename> —`. */
function projectChip(page: Page) {
  return page.getByTestId("draft-project-control");
}

/** Inject a worktree session via the mock and surface it in the sidebar. The mock
 *  script mutates the session list WITHOUT emitting a SessionDriverEvent, so the
 *  server's dirty-flag ticker never fires. The sidebar's open-on-refresh $effect
 *  fetches immediately on open, so toggling the sidebar closed→open surfaces the
 *  new row deterministically (the 10s client-side poll is the only other delivery
 *  path and is timing-sensitive). Same pattern as sidebar-refresh.e2e.ts AC.3.
 *  Returns the worktree session's row locator. */
async function injectWorktreeSession(page: Page) {
  const sidebar = page.getByTestId("sidebar");
  await mockScript(page, "worktree-session");
  // Give the server a beat to process the mock WS message before we refresh —
  // the message is async, and a refresh that races ahead of it won't see the
  // new session yet.
  await page.waitForTimeout(200);
  // Close + reopen to trigger the open-on-refresh fetch.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await openSidebar(page);
  const wtRow = sidebar.locator(".row-wrap").filter({ hasText: "Worktree session" });
  await expect(wtRow).toBeVisible({ timeout: 5_000 });
  return wtRow;
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("⌘N on a worktree session defaults the draft to the parent project (AC.1)", async ({
  page,
}) => {
  await openSidebar(page);

  // Inject a worktree session (cwd = worktree dir, worktree.base = parent project)
  // and focus it.
  const wtRow = await injectWorktreeSession(page);
  await wtRow.locator(".row").click();

  // The worktree session is now the viewed session. Trigger ⌘N.
  await page.keyboard.press("Meta+n");

  // The draft's project chip must show the PARENT project basename, not the worktree
  // dir basename — proving newSessionHotkey resolved projectCwdOf (worktree.base).
  const chip = projectChip(page);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(PARENT_BASENAME);
  await expect(chip).not.toContainText(WORKTREE_BASENAME);
  // The title carries the full parent project path — a precise guard that the
  // substring toContainText above can't provide alone ("pantoken" ⊂ "pantoken-worktree").
  await expect(chip).toHaveAttribute("title", `Project: ${PARENT_PROJECT} — click to browse for a directory (⌥P)`);
});

test("the sidebar's top + button on a worktree session defaults the draft to the parent project (AC.2)", async ({
  page,
}) => {
  await openSidebar(page);

  const wtRow = await injectWorktreeSession(page);
  await wtRow.locator(".row").click();

  // Click the sidebar's top "+" new-session button (uses activeCwd, now resolved via
  // projectCwdOf to the parent project).
  await page.getByTestId("sidebar").getByTestId("sidebar-new-session").locator(".new-btn").click();

  const chip = projectChip(page);
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(PARENT_BASENAME);
  await expect(chip).not.toContainText(WORKTREE_BASENAME);
  await expect(chip).toHaveAttribute("title", `Project: ${PARENT_PROJECT} — click to browse for a directory (⌥P)`);
});

test("opening a worktree session persists the parent project as lastProjectCwd (AC.3)", async ({
  page,
}) => {
  await openSidebar(page);

  // Clicking the row focuses it → openSession → setLastProjectCwd(projectCwdOf(entry)).
  const wtRow = await injectWorktreeSession(page);
  await wtRow.locator(".row").click();

  // The persisted "last project" must be the parent project path, not the worktree
  // dir — so the ⌘N fallback (lastProjectCwd) is also correct.
  const persisted = await page.evaluate(() =>
    localStorage.getItem("pantoken.lastProjectCwd"),
  );
  expect(persisted).toBe(PARENT_PROJECT);
});

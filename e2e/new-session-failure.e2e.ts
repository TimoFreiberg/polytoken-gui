import { expect, type Page, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// When creating a new session fails before any session exists (e.g. the real driver's
// `jj workspace add` hits a stale working copy), the draft must NOT silently vanish:
// the first prompt was already cleared from the composer on submit, and a failed
// new-session prompt has no transcript surface, so without recovery the text is lost.
// `drive(page, "failnewsession")` arms a one-shot mock newSession() rejection.

const draftBox = (page: Page) =>
  page.getByPlaceholder("Describe a task or ask a question…");

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a failed new session auto-restores its draft when the pane is free", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();

  await drive(page, "failnewsession"); // arm the one-shot creation failure
  const prompt = "build the worktree and start hacking";
  await draftBox(page).fill(prompt); // refocuses the composer
  await draftBox(page).press("Enter"); // submit -> creation fails server-side

  // The draft comes back with the prompt intact (no competing draft -> auto-restore).
  await expect(draftBox(page)).toHaveValue(prompt);
});

test("a failed new session offers a restore toast when another draft is in progress", async ({
  page,
}) => {
  await openSidebar(page);
  // Arm the failure while still connected, then drop the socket so the doomed
  // newSession is queued (not yet attempted) and we can set up a competing draft.
  await drive(page, "failnewsession");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(
    page.getByText("Offline — the agent keeps running"),
  ).toBeVisible();

  // Draft A: submit offline -> queued, draft cleared.
  await page.getByRole("button", { name: "New session…" }).click();
  await draftBox(page).fill("the doomed session");
  await draftBox(page).press("Enter");

  // Draft B: start a different draft and type into it (the one we must not clobber).
  await page.getByRole("button", { name: "New session…" }).click();
  await draftBox(page).fill("a different idea I'm typing");

  // Reconnect -> the queued newSession flushes and fails. Draft B is non-empty, so the
  // recovery offers a sticky toast rather than overwriting it.
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByText("New session couldn't start — restore your prompt?"),
  ).toBeVisible();
  await expect(draftBox(page)).toHaveValue("a different idea I'm typing");

  // Taking the offer swaps in the recovered prompt.
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(draftBox(page)).toHaveValue("the doomed session");
});

test("a failed new session overwrites an empty competing draft without a toast", async ({
  page,
}) => {
  await openSidebar(page);
  await drive(page, "failnewsession");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pantoken:test-disconnect")),
  );
  await expect(
    page.getByText("Offline — the agent keeps running"),
  ).toBeVisible();

  // Draft A: submit offline -> queued, draft cleared.
  await page.getByRole("button", { name: "New session…" }).click();
  await draftBox(page).fill("the doomed session");
  await draftBox(page).press("Enter");

  // Draft B: opened but left empty — nothing to lose, so recovery overwrites it.
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(draftBox(page)).toHaveValue("");

  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(draftBox(page)).toHaveValue("the doomed session");
  await expect(
    page.getByText("New session couldn't start — restore your prompt?"),
  ).toBeHidden();
});

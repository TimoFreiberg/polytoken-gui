import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// When opening a session that the TUI holds (a 409 lease conflict), the operator
// gets a sticky toast with a "Retry" action. Tapping Retry re-sends the
// openSession; the mock's one-shot failure clears on the second attempt, so the
// session opens. Non-lease session-switch errors keep the 8s auto-dismiss toast
// (no Retry button — they aren't blindly retryable).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a lease conflict surfaces a sticky Retry toast; retrying opens the session", async ({
  page,
}) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  // Arm the one-shot 409 failure for the NEXT openSession (switching to a
  // different session triggers it).
  await drive(page, "failsession");

  // Switch to a different session — the first attempt throws the 409.
  await sidebar.getByText("Explore the fold reducer").click();

  // The toast appears with the lease-conflict message.
  const toast = page.getByTestId("toast").filter({ hasText: "another TUI is attached" });
  await expect(toast).toBeVisible();

  // The Retry action button is present (sticky — no auto-dismiss).
  await expect(toast.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

  // The toast is sticky: it persists past the 8s auto-dismiss window (the operator
  // may be detaching in the TUI). Use a generous poll + a short wait to prove it.
  await page.waitForTimeout(2000);
  await expect(toast).toBeVisible();

  // Click Retry → the second openSession succeeds (the one-shot flag cleared).
  await toast.getByRole("button", { name: "Retry", exact: true }).click();

  // The session opens — its greeting text appears, proving the retry landed.
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();

  // The toast dismissed on the Retry click (the action runs dismissToast).
  await expect(toast).toHaveCount(0);
});

test("a non-lease session-switch error does NOT get a Retry button", async ({
  page,
}) => {
  // The failnewsession path produces a non-lease error (a new-session failure,
  // not a lease conflict). When a competing draft is in progress, it surfaces a
  // recovery toast with a "Restore" action — NOT a "Retry" action. This proves
  // the Retry button is exclusive to lease conflicts, not every session failure.
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
  const composer = page.getByPlaceholder("Describe a task or ask a question…");
  await composer.fill("the doomed session");
  await composer.press("Enter");

  // Draft B: start a different draft so recovery offers a toast (not auto-restore).
  await page.getByRole("button", { name: "New session…" }).click();
  await composer.fill("a different idea I'm typing");

  // Reconnect -> the queued newSession flushes and fails → recovery toast appears.
  await page.getByRole("button", { name: "Reconnect" }).click();
  const toast = page.getByTestId("toast").filter({
    hasText: "New session couldn't start",
  });
  await expect(toast).toBeVisible();

  // The recovery toast has a Restore button, NOT a Retry button. The Retry action
  // is exclusive to lease conflicts — non-lease session failures use Restore.
  await expect(toast.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(toast.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

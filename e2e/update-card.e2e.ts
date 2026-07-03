import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The desktop update card (sidebar). It's driven by the server's `updateStatus`, which
// the desktop shell's updater loop normally sets via POST /update/state — here we POST it
// directly to stand in for the updater, since the mock harness has no real update channel.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("shows when an update is staged and reflects applying on click", async ({
  page,
}) => {
  await openSidebar(page);
  const card = page.getByTestId("update-card");
  await expect(card).toBeHidden(); // nothing staged on a fresh load

  // The updater reports a staged-but-deferred update.
  await page.request.post("/update/state", {
    data: { available: true, sha: "abc1234" },
  });

  await expect(card).toBeVisible();
  const apply = card.getByRole("button", { name: "Update now" });
  await expect(apply).toBeVisible();

  await apply.click();
  // Clicking sends applyUpdate → the server marks it applying → the card reflects it.
  await expect(card.getByRole("button", { name: "Updating…" })).toBeVisible();
});

test("clears when the update is no longer available", async ({ page }) => {
  await openSidebar(page);
  await page.request.post("/update/state", {
    data: { available: true, sha: "abc1234" },
  });
  await expect(page.getByTestId("update-card")).toBeVisible();

  await page.request.post("/update/state", { data: { available: false } });
  await expect(page.getByTestId("update-card")).toBeHidden();
});

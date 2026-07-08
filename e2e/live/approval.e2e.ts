import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PANTOKEN_DRIVER=fake). See streaming.e2e.ts for the structural-only +
// unrun-in-session caveats.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("a tool-call approval raises a modal approval dialog", async ({ page }) => {
  await driveLive(page, "approve");

  // The tool-call-approval corpus raises a permission interrogative → the modal
  // approval sheet (role=dialog, aria-modal). Title + option labels are corpus-
  // specific, so we assert the modal shape only.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
});

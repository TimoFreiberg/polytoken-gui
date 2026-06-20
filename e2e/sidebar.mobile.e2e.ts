import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// Runs under the "mobile" project (Pixel 7 viewport).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("opening the drawer does NOT focus the search box on a phone", async ({
  page,
}) => {
  // Focus-on-open is desktop-only: on a phone it would pop the soft keyboard on every
  // open. Opening the drawer (a closed→open transition) must leave the search unfocused.
  await openSidebar(page);
  const search = page
    .getByTestId("sidebar")
    .getByPlaceholder("Search sessions…");
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
});

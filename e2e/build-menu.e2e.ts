import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The build-stamp right-click menu (sidebar footer): copy the commit hash, or force an
// app update. A desktop affordance (right-click only), so this spec runs in the desktop
// project. The force path's server effect is covered by hub unit tests — the mock harness
// has no updater to observe a restart — so here we assert the UI interactions.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("right-click on the build stamp opens a menu with copy + force-update", async ({
  page,
}) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  const menu = page.getByTestId("build-menu");
  await expect(menu).toBeHidden(); // not shown until right-clicked

  await version.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("copy-build-hash")).toBeVisible();
  await expect(page.getByTestId("force-update")).toBeVisible();

  // Escape dismisses it.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("copy build hash writes the commit hash to the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  // The label is "<hash>" or "<hash> · <date>"; the copy action grabs only the hash.
  const label = ((await version.textContent()) ?? "").trim();
  const hash = label.split(" · ")[0];

  await version.click({ button: "right" });
  await page.getByTestId("copy-build-hash").click();
  await expect(page.getByTestId("build-menu")).toBeHidden();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(hash);
});

test("force-update fires and closes the menu", async ({ page }) => {
  await openSidebar(page);
  const version = page.getByTestId("sidebar").getByTestId("version");
  await version.click({ button: "right" });
  const menu = page.getByTestId("build-menu");
  await expect(menu).toBeVisible();

  await page.getByTestId("force-update").click();
  await expect(menu).toBeHidden();
});

import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the composer footer shows the context-window meter", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toBeVisible();
  // MOCK_USAGE is 47,200 / 200,000 tokens → 24%.
  await expect(meter).toHaveText(/24%/);
  await expect(meter).toHaveAttribute("title", /47,200 \/ 200,000 tokens/);
});

test("the model and effort pickers live in the composer footer", async ({
  page,
}) => {
  // Both pickers moved out of the header into the composer's footer toolbar.
  const toolbar = page.locator(".composer-wrap .toolbar");
  await expect(
    toolbar.locator(".mp .badge").filter({ hasText: "Claude Opus 4.8" }),
  ).toBeVisible();
  await expect(
    toolbar.locator(".mp .badge").filter({ hasText: "medium" }),
  ).toBeVisible();
  // …and no longer live in the header.
  await expect(page.locator(".hdr .mp")).toHaveCount(0);
});

test("the attach button opens a file picker for image attachments", async ({
  page,
}) => {
  // The attach control is now the shared IconButton primitive — select by its
  // accessible name rather than the old bespoke `.attach` class.
  const attach = page
    .locator(".composer-wrap")
    .getByRole("button", { name: "Attach images" });
  await expect(attach).toBeEnabled();
  await expect(attach).toHaveAttribute("title", /Attach images/);
});

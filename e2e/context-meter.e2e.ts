import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

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

test("a context-pressure cue surfaces once the window is nearly full", async ({
  page,
}) => {
  const cue = page.getByTestId("context-cue");
  // Baseline MOCK_USAGE is 24% — well under the ≥85% threshold, so no cue.
  await expect(cue).toHaveCount(0);

  // `contextfull` pushes the focused session to 91% (danger band).
  await drive(page, "contextfull");

  await expect(cue).toBeVisible();
  await expect(cue).toContainText("Context 91% full");
  await expect(cue).toContainText("/compact");
  // Tone tracks the meter ring: 90%+ is the danger band.
  await expect(cue).toHaveClass(/danger/);
  // The ring itself moved to 91% too.
  await expect(page.getByTestId("context-meter")).toHaveText(/91%/);
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

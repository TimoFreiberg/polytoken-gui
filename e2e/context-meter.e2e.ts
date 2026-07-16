import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the composer status row shows a ring-only context trigger", async ({ page }) => {
  const ring = page.getByTestId("context-meter");
  const trigger = page.getByTestId("context-trigger");
  await expect(ring).toBeVisible();
  // The inline trigger is intentionally quiet; exact usage remains in its popup.
  await expect(ring).not.toHaveText(/%/);
  await expect(trigger).toHaveAttribute("aria-label", /Context window/);
  await expect(trigger).toHaveAttribute("title", /exact context window usage/);
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
  // The ring remains text-free; the trigger label carries the current band for assistive tech.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute("aria-label", /91% used/);
});

test("the model and effort pickers live beside the context ring", async ({
  page,
}) => {
  const right = page.getByTestId("composer-status-right");
  await expect(right.getByTestId("model-badge")).toContainText("Claude Opus 4.8");
  await expect(right.getByTestId("model-badge")).toContainText("medium");
  await expect(right.getByTestId("context-trigger")).toBeVisible();
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

test("the context meter popup shows detail on click", async ({ page }) => {
  const meter = page.getByTestId("context-meter");
  await expect(meter).toBeVisible();
  // Click the meter to pin the popup open.
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText(/tokens/);
  await expect(popup).toContainText(/of window/);
  // The popup has Compact + Clear context action buttons.
  await expect(page.getByTestId("compact-btn")).toBeVisible();
  await expect(page.getByTestId("clear-context-btn")).toBeVisible();
});

test("the Compact button uses a click-twice confirm gate", async ({ page }) => {
  await drive(page, "contextfull");
  const meter = page.getByTestId("context-meter");
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  const compactBtn = page.getByTestId("compact-btn");
  // First click arms.
  await compactBtn.click();
  await expect(compactBtn).toHaveText("Click again");
  // Second click fires.
  await compactBtn.click();
  // The mock emits a usageUpdated — the accessible trigger drops to 4%.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute("aria-label", /4% used/);
});

test("the Clear context button uses a click-twice confirm gate", async ({
  page,
}) => {
  await drive(page, "contextfull");
  const meter = page.getByTestId("context-meter");
  await meter.click();
  const popup = page.getByTestId("context-popup");
  await expect(popup).toBeVisible();
  const clearBtn = page.getByTestId("clear-context-btn");
  // First click arms.
  await clearBtn.click();
  await expect(clearBtn).toHaveText("Click again");
  // Second click fires.
  await clearBtn.click();
  // The mock emits a usageUpdated — the accessible trigger drops to 0%.
  await expect(page.getByTestId("context-trigger")).toHaveAttribute("aria-label", /0% used/);
});

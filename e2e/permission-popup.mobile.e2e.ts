import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// Runs under the "mobile" project (Pixel 7 viewport, hasTouch). Verifies the
// permission card's layout + tap targets are comfortable on a phone.

test("mobile: permission card options are full-width tap targets", async ({
  page,
}) => {
  await drive(page, "permission");
  const dialog = page.getByRole("dialog", { name: "Run bash?" });
  await expect(dialog).toBeVisible();

  // The tool name + input preview render on the narrow viewport.
  await expect(dialog.getByText("shell_exec")).toBeVisible();
  await expect(dialog.locator(".tool-input")).toBeVisible();

  // 3 pruned options (not 7) — AC.2.
  const options = dialog.getByRole("radio");
  await expect(options).toHaveCount(3);

  // Each option is a comfortable full-width tap target (block buttons).
  for (const btn of await options.all()) {
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    // Pixel 7 viewport width is 412px; full-width options should span most of it.
    expect(box!.width).toBeGreaterThan(280);
  }

  // Tapping "Allow for session" resolves the card.
  await dialog
    .getByRole("radio", { name: "Allow for session", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Received: Allow for session")).toBeVisible();
});

test("mobile: permission card input preview scrolls without overflowing", async ({
  page,
}) => {
  await drive(page, "permission");
  const dialog = page.getByRole("dialog");
  const input = dialog.locator(".tool-input");
  await expect(input).toBeVisible();
  // The scroll cap keeps the preview bounded on a phone.
  await expect(input).toHaveCSS("overflow", "auto");
  await expect(input).toHaveCSS("max-height", "180px");
});

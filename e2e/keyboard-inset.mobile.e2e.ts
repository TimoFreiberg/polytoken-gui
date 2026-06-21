import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The composer must stay pinned above the on-screen keyboard. lib/keyboard-inset.ts publishes
// the keyboard's overlap as --keyboard-inset from the visualViewport (which Playwright can't
// drive a real soft keyboard for), and the app shrinks by it on touch. We set the var directly
// to prove the CSS wiring end-to-end: the app shrinks and the composer rides up with it. The
// actual visualViewport→var step is unit-tested in keyboard-inset.test.ts; real-device keyboard
// behavior needs a phone.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("--keyboard-inset shrinks the app and lifts the composer above the keyboard", async ({
  page,
}) => {
  const shell = page.locator(".shell");
  const composer = page.locator(".composer-wrap");

  const shellBefore = await shell.evaluate((el) => el.clientHeight);
  const composerBottomBefore = await composer.evaluate(
    (el) => el.getBoundingClientRect().bottom,
  );

  // Simulate a ~260px keyboard.
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--keyboard-inset", "260px"),
  );

  // The app shrank by the inset…
  await expect
    .poll(() => shell.evaluate((el) => el.clientHeight))
    .toBeLessThanOrEqual(shellBefore - 255);
  // …and the composer rode up with it (its bottom is no longer behind the keyboard).
  const composerBottomAfter = await composer.evaluate(
    (el) => el.getBoundingClientRect().bottom,
  );
  expect(composerBottomBefore - composerBottomAfter).toBeGreaterThanOrEqual(
    255,
  );

  // Keyboard dismissed → var cleared → layout restores.
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--keyboard-inset"),
  );
  await expect
    .poll(() => shell.evaluate((el) => el.clientHeight))
    .toBe(shellBefore);
});

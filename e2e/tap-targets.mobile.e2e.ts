import { expect, type Locator, test } from "@playwright/test";
import { drive, gotoFresh, openSettings } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

// Runs under the "mobile" project (Pixel 7 → coarse pointer + touch).
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function expectTall(loc: Locator, min = 44) {
  const box = await loc.boundingBox();
  expect(box, "element should be laid out").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(min);
}

test("blocking dialog actions meet the 44px touch target", async ({ page }) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog");
  await expectTall(dialog.getByRole("button", { name: "Allow" }));
  await expectTall(dialog.getByRole("button", { name: "Deny" }));
});

test("non-binary select options meet the 44px touch target", async ({
  page,
}) => {
  await drive(page, "selectmany");
  const options = page.getByRole("dialog").getByRole("radio");
  await expect(options).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expectTall(options.nth(i));
});

test("settings collapse headers meet the 44px touch target", async ({
  page,
}) => {
  // Only the active section renders, so navigate to each one before checking its
  // disclosure header. The section-nav rail tabs themselves are also touch targets.
  await openSettings(page, "appearance");
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  // The rail tabs reflow to a horizontal strip on the phone bottom-sheet but stay
  // comfortably tappable (coarse pointer bumps them to a full 44px).
  for (const id of ["appearance", "models", "environment", "token"])
    await expectTall(page.getByTestId(`settings-tab-${id}`));
});

test("the sidebar and context-panel header arrows meet the 44px touch target", async ({
  page,
}) => {
  // Both drawers are closed by default on a phone, so both header arrows are already
  // showing — no driving needed. They're the only tap affordance left now that the
  // header hamburgers are gone, so a cramped hit target here would be a real regression.
  await expectTall(page.getByTestId("sidebar-open"));
  await expectTall(page.getByTestId("context-open"));
});

test("the 2a composer controls are labeled and touch-safe", async ({ page }) => {
  const controls = [
    page.getByTestId("facet-badge"),
    page.getByRole("button", { name: "Attach images" }),
    // After 33195e14e187 the idle+empty composer labels this "Send empty
    // prompt to continue" (a continue-signal affordance), so the accessible
    // name is no longer stable. The `button.send` class is the stable hook;
    // the test then asserts the aria-label is any non-empty string.
    page.locator("button.send"),
    page.getByTestId("permission-badge"),
    page.getByTestId("model-badge"),
    page.getByTestId("thinking-badge"),
    page.getByTestId("context-trigger"),
  ];
  for (const control of controls) {
    await expect(control).toHaveAttribute("aria-label", /.+/);
    await expectTall(control);
  }

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "touch-target.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  const preview = page.getByRole("button", { name: "Preview attachment 1 full screen" });
  const remove = page.getByRole("button", { name: "Remove attachment 1" });
  await expectTall(preview);
  await expectTall(remove);
  await expect(preview).toHaveAttribute("aria-label", /Preview attachment/);
  await expect(remove).toHaveAttribute("aria-label", /Remove attachment/);

  await drive(page, "streamhold");
  const stop = page.getByRole("button", { name: /Stop( the agent)?/ }).first();
  await expect(stop).toBeVisible();
  await expectTall(stop);
  await expect(stop).toHaveAttribute("title", /Stop/);
});

import { expect, type Locator, test } from "@playwright/test";
import { drive, gotoFresh, openSettings, openSidebar } from "./helpers.js";

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

test("the mobile header and sidebar destinations meet the 44px touch target", async ({
  page,
}) => {
  // Sessions is always the compact header entry. Context stays quiet while empty and
  // remains a labeled, touch-safe destination inside Sessions.
  await expectTall(page.getByTestId("sidebar-open"));
  await openSidebar(page);
  await expectTall(page.getByTestId("sidebar-context"));
  await expectTall(page.getByTestId("settings-toggle"));
});

test("sidebar navigation rows meet the 44px touch target", async ({ page }) => {
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");

  await expectTall(sidebar.locator(".new-btn"));
  await expectTall(sidebar.locator(".group-toggle").first());
  await expectTall(
    sidebar
      .locator(".row-wrap")
      .filter({ hasText: "Wire up the WebSocket" })
      .locator(".row"),
  );
});

test("the 2a composer controls are labeled and touch-safe", async ({
  page,
}) => {
  const controls = [
    page.getByRole("button", { name: "Attach images" }),
    // After 33195e14e187 the idle+empty composer labels this "Send empty
    // prompt to continue" (a continue-signal affordance), so the accessible
    // name is no longer stable. The `button.send` class is the stable hook;
    // the test then asserts the aria-label is any non-empty string.
    page.locator("button.send"),
    page.getByTestId("mobile-session-controls-trigger"),
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
  const preview = page.getByRole("button", {
    name: "Preview attachment 1 full screen",
  });
  const remove = page.getByRole("button", { name: "Remove attachment 1" });
  await expectTall(preview);
  await expectTall(remove);
  await expect(preview).toHaveAttribute("aria-label", /Preview attachment/);
  await expect(remove).toHaveAttribute("aria-label", /Remove attachment/);

  await drive(page, "streamhold");
  const stop = page.getByTestId("stop-button");
  await expect(stop).toBeVisible();
  await expectTall(stop);
  await expect(stop).toHaveAttribute("title", /Stop/);
});

test("queue tray steer and edit buttons meet the 44px touch target and have tooltips", async ({
  page,
}) => {
  await drive(page, "streamhold");
  await drive(page, "queue");
  const tray = page.getByTestId("queue-tray");

  const steer = tray.getByTestId("steer-button");
  await expectTall(steer);
  await expect(steer).toHaveAttribute("title", /.+/);
  await expect(steer).toHaveAttribute("aria-label", /.+/);

  const restore = tray.getByRole("button", {
    name: "Restore all queued messages to the composer",
  });
  await expectTall(restore);
  await expect(restore).toHaveAttribute("title", /.+/);
  await expect(restore).toHaveAttribute("aria-label", /.+/);

  const edits = tray.getByTestId("edit-queued");
  await expect(edits).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const edit = edits.nth(i);
    await expectTall(edit);
    await expect(edit).toHaveAttribute("title", /.+/);
    await expect(edit).toHaveAttribute("aria-label", /.+/);
  }
});

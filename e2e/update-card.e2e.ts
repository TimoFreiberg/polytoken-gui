import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The desktop update card (sidebar). It's driven by the server's `updateStatus`, which
// the update-watcher normally sets via POST /update/state — here we POST it directly to
// stand in for the watcher, since the mock harness has no real clone to update.
test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("shows when an update is staged and reflects applying on click", async ({
  page,
}) => {
  await openSidebar(page);
  const card = page.getByTestId("update-card");
  await expect(card).toBeHidden(); // nothing staged on a fresh load

  // The watcher reports a staged-but-deferred update.
  await page.request.post("/update/state", {
    data: { available: true, sha: "abc1234" },
  });

  await expect(card).toBeVisible();
  const apply = card.getByRole("button", { name: "Update now" });
  await expect(apply).toBeVisible();

  await apply.click();
  // Clicking sends applyUpdate → the server marks it applying → the card reflects it.
  await expect(card.getByRole("button", { name: "Updating…" })).toBeVisible();
});

test("clears when the update is no longer available", async ({ page }) => {
  await openSidebar(page);
  await page.request.post("/update/state", {
    data: { available: true, sha: "abc1234" },
  });
  await expect(page.getByTestId("update-card")).toBeVisible();

  await page.request.post("/update/state", { data: { available: false } });
  await expect(page.getByTestId("update-card")).toBeHidden();
});

// The durable "rebuild the .app" dot on the build stamp. Driven by `desktopStale` on the
// same /update/state report (running Pilot.app vs the clone's HEAD:desktop). Independent of
// the update card — a stale binary has nothing to do with a staged TS commit — so it shows
// even when `available` is false.
test("build-stamp dot shows when the .app shell is stale, independent of the card", async ({
  page,
}) => {
  await openSidebar(page);
  const dot = page.getByTestId("desktop-stale-dot");
  await expect(dot).toBeHidden(); // fresh load: binary matches its source
  await expect(page.getByTestId("update-card")).toBeHidden();

  // Watcher reports a stale .app with NO staged TS update.
  await page.request.post("/update/state", {
    data: { available: false, desktopStale: true },
  });
  await expect(dot).toBeVisible();
  await expect(page.getByTestId("update-card")).toBeHidden(); // still no card

  // A rebuild clears it.
  await page.request.post("/update/state", {
    data: { available: false, desktopStale: false },
  });
  await expect(dot).toBeHidden();
});

test("omitting desktopStale on a later report leaves the dot lit", async ({
  page,
}) => {
  await openSidebar(page);
  const dot = page.getByTestId("desktop-stale-dot");
  await page.request.post("/update/state", {
    data: { available: false, desktopStale: true },
  });
  await expect(dot).toBeVisible();

  // A card report that doesn't mention desktopStale must not clear the dot.
  await page.request.post("/update/state", {
    data: { available: true, sha: "abc1234" },
  });
  await expect(page.getByTestId("update-card")).toBeVisible();
  await expect(dot).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("plan-handoff card: 3 buttons stack full-width and the body scrolls on mobile", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();

  // The plan body is a scrollable container (layout sanity on a phone viewport).
  const body = dialog.locator(".plan-body");
  await expect(body).toBeVisible();
  // The scroll cap keeps the sheet bounded even with a long plan.
  await expect(body).toHaveCSS("overflow-y", "auto");

  // The 3-up action layout stacks to a single column on narrow widths so each
  // button is a full-width tap target rather than a cramped third.
  const actions = dialog.locator(".actions.three");
  await expect(actions).toHaveCSS("flex-direction", "column");
  const buttons = actions.getByRole("button");
  await expect(buttons).toHaveCount(3);
  // Each button is full-width (block) — a comfortable tap target.
  for (const btn of await buttons.all()) {
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    // Pixel 7 viewport width is 412px; full-width buttons should span most of it.
    expect(box!.width).toBeGreaterThan(280);
  }

  // Cancel dismisses the card. The button sends {value:"Cancel"} (not {cancelled}),
  // so the mock acks it as "Received: Cancel" — distinct from the Esc path.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Received: Cancel")).toBeVisible();
});

test("facet badge renders on mobile when the facet is plan", async ({ page }) => {
  await drive(page, "planfacet");
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Plan mode");
  // Reverts to execute after the dwell → badge hides.
  await expect(badge).toBeHidden();
});

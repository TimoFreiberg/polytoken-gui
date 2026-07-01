import { expect, test } from "@playwright/test";
import { gotoFresh } from "./helpers.js";

// The permission-monitor badge (composer toolbar) shows the daemon's live
// per-session permission mode (standard/bypass/autonomous) and lets the user
// switch it. Mirrors the facet badge: clicking the chip opens a 3-item panel;
// selecting emits a setPermissionMonitor wire → mock emits a sessionUpdated
// snapshot carrying the new permissionMonitor → foldEvent propagates → badge
// updates.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("permission badge shows Standard by default and switches mode", async ({
  page,
}) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toBeVisible();
  // Seeded "standard" by the mock's snapshot() base.
  await expect(badge).toContainText("Standard");

  // Open the panel + pick Bypass.
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();
  await panel.getByRole("option", { name: /Bypass/ }).click();

  // The badge updates to the new mode (accent-tinted, non-standard).
  await expect(badge).toContainText("Bypass");
  await expect(badge).toHaveClass(/nonstandard/);
});

test("permission badge sits in the composer toolbar, left of the facet badge", async ({
  page,
}) => {
  // AC.3 — the badge lives in the composer footer toolbar (.toolbar-right),
  // left of the facet badge (row reads permission → facet → model → effort).
  const order = await page
    .locator(".toolbar-right [data-testid]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.indexOf("permission-badge")).toBeLessThan(
    order.indexOf("facet-badge"),
  );
});

test("permission panel is keyboard-navigable (Esc closes, arrows move, Enter picks)", async ({
  page,
}) => {
  const badge = page.getByTestId("permission-badge");
  await badge.click();
  const panel = page.getByRole("listbox", { name: "Permission mode" });
  await expect(panel).toBeVisible();

  // Arrow down once (standard → bypass), Enter picks.
  await panel.press("ArrowDown");
  await panel.press("Enter");
  await expect(badge).toContainText("Bypass");

  // Reopen, Esc closes without changing.
  await badge.click();
  await expect(panel).toBeVisible();
  await panel.press("Escape");
  await expect(panel).toBeHidden();
  await expect(badge).toContainText("Bypass");
});

test("⌘⇧M cycles permission mode", async ({ page }) => {
  const badge = page.getByTestId("permission-badge");
  await expect(badge).toContainText("Standard");

  // ⌘⇧M cycles: Standard → Bypass.
  await page.keyboard.press("Control+Shift+M");
  await expect(badge).toContainText("Bypass");

  // Again: Bypass → Autonomous.
  await page.keyboard.press("Control+Shift+M");
  await expect(badge).toContainText("Autonomous");

  // Again: Autonomous → Standard (wraps).
  await page.keyboard.press("Control+Shift+M");
  await expect(badge).toContainText("Standard");
});

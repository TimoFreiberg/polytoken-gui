import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("plan-handoff card renders the plan markdown + 3 action buttons", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog", { name: "Plan handoff" });
  await expect(dialog).toBeVisible();

  // The plan doc's friendly path is shown so the operator knows what they're approving.
  await expect(dialog.getByText("plan.md")).toBeVisible();

  // The plan markdown body renders — a heading from the planText is visible, and the
  // scrollable container is present (AC.1).
  await expect(dialog.getByRole("heading", { name: "Plan: Add facet indicator + plan-handoff card" })).toBeVisible();
  await expect(dialog.locator(".plan-body")).toBeVisible();

  // The 3 action buttons carry the daemon's action_labels (not hardcoded strings),
  // in PlanHandoffDecision order (AC.2).
  for (const label of [
    "Implement (new context)",
    "Implement (current context)",
    "Cancel",
  ]) {
    await expect(
      dialog.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }
});

test("clicking Implement (new context) resolves the card", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Implement (new context)", exact: true })
    .click();
  // The mock acks a value response with "Received: <value>".
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("Escape cancels the plan-handoff card (deny-safe)", async ({ page }) => {
  await drive(page, "planhandoff");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("⌘/Ctrl+Enter submits the primary action (Implement, new context)", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText("Received: Implement (new context)")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("facet badge shows 'Plan mode' when the active facet is plan", async ({
  page,
}) => {
  await drive(page, "planfacet");
  // The badge appears while the snapshot carries facet:"plan" (AC.4).
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Plan mode");
  await expect(badge).toHaveAttribute("title", "Active facet: plan");
  // After the dwell, the script reverts to facet:"execute" and the badge disappears.
  await expect(badge).toBeHidden();
});

test("no facet badge in the default (execute) state", async ({ page }) => {
  // The greeting fixture's default state has no facet (or execute) — no badge.
  await expect(page.getByTestId("facet-badge")).toBeHidden();
});

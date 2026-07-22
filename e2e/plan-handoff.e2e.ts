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
  // scrollable container is present.
  await expect(dialog.getByRole("heading", { name: "Plan: Add facet indicator + plan-handoff card" })).toBeVisible();
  await expect(dialog.locator(".plan-body")).toBeVisible();

  // The 3 action buttons carry the daemon's action_labels (not hardcoded strings),
  // in PlanHandoffDecision order.
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

test("plan-handoff Cancel uses a click-twice confirm gate", async ({ page }) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog");

  // ── AC.2: first click arms, does not dismiss ──────────────────
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Click again" })).toBeVisible();
  // Dialog is still visible (not dismissed).
  await expect(dialog).toBeVisible();

  // ── AC.6: armed button carries the .armed class + danger color ─
  const armedBtn = dialog.getByRole("button", { name: "Click again" });
  await expect(armedBtn).toHaveClass(/\bbtn\b.*\barmed\b/);
  const dangerColor = await page.evaluate(() => {
    const el = document.querySelector(".sheet.plan .actions .btn.armed") as HTMLElement | null;
    return el ? getComputedStyle(el).color : null;
  });
  expect(dangerColor).not.toBeNull();
  expect(dangerColor).toMatch(/rgb|rgba|hsl|hsla/);

  // Second click fires the cancel — mock acks as "Received: Cancel".
  await armedBtn.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Received: Cancel")).toBeVisible();
});

test("plan-handoff Cancel Esc disarms when armed without cancelling", async ({
  page,
}) => {
  await drive(page, "planhandoff");
  const dialog = page.getByRole("dialog");

  // Arm the cancel gate.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Click again" })).toBeVisible();

  // AC.4: Esc while armed disarms (label reverts) without cancelling.
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  // The dialog is still visible (Esc did NOT cancel).
  await expect(dialog).toBeVisible();
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

test("facet badge shows 'Plan' when the active facet is plan", async ({
  page,
}) => {
  await drive(page, "planfacet");
  // The badge shows the actual facet "Plan" (accent-tinted) while the snapshot
  // carries facet:"plan".
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveAttribute("title", /⇧Tab/);
  // After the dwell, the script reverts to facet:"execute" and the badge returns
  // to its subtle "Execute" chip (always visible — a state readout, not a toggle
  // that hides).
  await expect(badge).toHaveText("Execute");
});

test("facet toggle shows 'Execute' in the default (execute) state", async ({
  page,
}) => {
  // The greeting fixture's default state has no facet (or execute) — the badge
  // shows the actual facet "Execute" (a state readout, always visible).
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Execute");
});

test("a timed-out plan card auto-dismisses to the cancel decision", async ({
  page,
}) => {
  // The deny-safe autoResolve path for a `plan` kind must send the Cancel label
  // (a typed plan_handoff_answer), not the universal {cancelled} — matching the
  // visible Cancel button's wire shape (the C1 fix).
  await drive(page, "planhandofftimeout");
  await expect(page.getByText(/Auto-dismiss in \d+s/)).toBeVisible();
  // After the timeout it auto-resolves to the deny-safe default (the cancel label).
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 8000 });
  await expect(page.getByText("Received: Cancel")).toBeVisible();
});

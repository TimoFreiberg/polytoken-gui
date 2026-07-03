import { expect, type Page, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

// The facet picker (in the composer toolbar) switches the active facet. Clicking
// it sends a setFacet wire message → the mock emits a sessionUpdated snapshot
// with the new facet → foldEvent propagates → the badge updates. The badge shows
// the ACTUAL current facet ("Execute"/"Plan"), not the old affordance label.
// ⌘⇧C (Cmd+Shift+C) cycles through all available facets — it fires even when
// the composer is focused (unlike the old Shift+Tab, which the browser consumed
// for reverse-focus traversal in form fields).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("clicking the facet badge opens a picker and switching works", async ({
  page,
}) => {
  // The badge shows the actual facet: "Execute" in the default (execute) state.
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Execute");

  // Click the badge → opens the dropdown picker. Click "Plan" to switch.
  await badge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(badge).toHaveText("Plan");
  await expect(badge).toHaveClass(/plan/);

  // Click the badge → opens the picker again. Click "Execute" to switch back.
  await badge.click();
  await page.getByRole("option", { name: "Execute" }).click();
  await expect(badge).toHaveText("Execute");
  await expect(badge).not.toHaveClass(/plan/);
});

test("the facet badge sits in the composer toolbar, left of the model badge", async ({
  page,
}) => {
  // AC.2 — the badge lives in the composer footer toolbar (.toolbar-right),
  // immediately left of the model/effort badges.
  const order = await page
    .locator(".toolbar-right [data-testid]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.indexOf("facet-badge")).toBeLessThan(
    order.indexOf("model-badge"),
  );
});

test("Cmd+Shift+C cycles facets even when the composer is focused", async ({
  page,
}) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Focus the composer textarea — the key fix: the hotkey must fire even here.
  await page.getByPlaceholder("Message pilot…").focus();

  // Cmd+Shift+C → switch to plan mode.
  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Plan");
});

test("Cmd+Shift+C cycles through all facets and wraps", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // The mock returns three facets: ["execute", "plan", "research"]. Pressing the
  // hotkey N (= facet count) times cycles execute → plan → research → execute (wrap).
  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Plan");

  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Research");

  await page.keyboard.press("Meta+Shift+C");
  await expect(badge).toHaveText("Execute");
});

test("Shift+Tab does not toggle facets", async ({ page }) => {
  const badge = page.getByTestId("facet-badge");
  await expect(badge).toHaveText("Execute");

  // Shift+Tab should perform normal browser reverse-focus traversal — it must
  // NOT cycle facets anymore. Press it and confirm the badge is unchanged.
  await page.keyboard.press("Shift+Tab");
  await expect(badge).toHaveText("Execute");
});

// --- Draft-mode tests (AC.1, AC.2) ---
// While a new-session draft is open, store.session still points at the previously
// focused session. The facet badge + Shift+Tab must read/write the DRAFT, not the
// old session. These tests guard against the regression where the draft view mutated
// the focused session instead.

test("⌘⇧C in the new-session draft cycles the DRAFT's facet, not the session's", async ({
  page,
}) => {
  await openSidebar(page);
  // The greeting session is focused — its facet badge reads "Execute".
  const liveBadge = page.getByTestId("facet-badge");
  await expect(liveBadge).toHaveText("Execute");

  // Open a new-session draft.
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();
  // The draft's facet badge also reads "Execute" (the draft default).
  const draftBadge = page.getByTestId("facet-badge");
  await expect(draftBadge).toHaveText("Execute");

  // ⌘⇧C cycles the draft's facet (not the previously focused session's).
  await page.keyboard.press("Meta+Shift+C");
  await expect(draftBadge).toHaveText("Plan");

  // Navigate back to the old session — its facet must be unchanged ("Execute").
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
});

test("clicking the facet badge in the draft view toggles the draft, not the old session", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar").getByText("New session…").click();
  await expect(page.getByTestId("new-session")).toBeVisible();

  const draftBadge = page.getByTestId("facet-badge");
  await expect(draftBadge).toHaveText("Execute");

  // Open the picker and select Plan — this writes to the draft.
  await draftBadge.click();
  await page.getByRole("option", { name: "Plan" }).click();
  await expect(draftBadge).toHaveText("Plan");

  // Navigate back to the old session — its facet is unchanged.
  await openSidebar(page);
  await row(page, "Wire up the WebSocket bridge").click();
  await expect(page.getByTestId("facet-badge")).toHaveText("Execute");
});

// Helper used by draft-mode tests: click a sidebar row by title.
function row(page: Page, title: string) {
  return page.getByTestId("sidebar").locator(".row", { hasText: title });
}

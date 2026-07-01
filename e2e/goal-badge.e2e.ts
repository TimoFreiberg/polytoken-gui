import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// The GoalBadge shows the active saved-session goal (summary + lifecycle state)
// in the StatusHeader subtitle. Driven by a snapshot carrying `goal` → foldEvent
// → state.goal → GoalBadge. Display-only (no click handler); a tooltip carries
// the full summary + lifecycle (repo rule: every UI element has a tooltip).

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("the goal badge renders with the summary and a full tooltip", async ({
  page,
}) => {
  // Before driving `goalactive`: no goal → no badge (AC.2 baseline).
  await expect(page.getByTestId("goal-badge")).toHaveCount(0);

  // Drive the goalactive fixture → a snapshot with goal lands.
  await drive(page, "goalactive");

  // The badge appears in the StatusHeader subtitle with the summary (AC.1).
  const badge = page.getByTestId("goal-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Ship the goal badge feature");

  // The tooltip carries the full summary + lifecycle state (AC.5).
  await expect(badge).toHaveAttribute(
    "title",
    "Goal: Ship the goal badge feature (active)",
  );
});

test("the goal badge hides when the goal is cleared", async ({ page }) => {
  // Drive goalactive → the badge appears.
  await drive(page, "goalactive");
  const badge = page.getByTestId("goal-badge");
  await expect(badge).toBeVisible();

  // Drive goalclear → a snapshot with goal:null clears state.goal → badge hides (AC.2).
  await drive(page, "goalclear");
  await expect(badge).toHaveCount(0);
});

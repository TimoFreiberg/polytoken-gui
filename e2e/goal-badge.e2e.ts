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
  // Before driving `goalactive`: no goal → no badge.
  await expect(page.getByTestId("goal-badge")).toHaveCount(0);

  // Drive the goalactive fixture → a snapshot with goal lands.
  await drive(page, "goalactive");

  // The badge appears in the StatusHeader subtitle with the summary.
  const badge = page.getByTestId("goal-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Ship the goal badge feature");

  // The tooltip carries the full summary + lifecycle state.
  await expect(badge).toHaveAttribute(
    "title",
    "Goal: Ship the goal badge feature (active)",
  );

  // An active goal is persistent context, not an attention request: it uses the
  // structural warm-nickel accent instead of spending the scarce gold highlight.
  const [badgeColor, accentColor] = await Promise.all([
    badge.evaluate((el) => getComputedStyle(el).color),
    page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  ]);
  expect(badgeColor).toBe(accentColor);
});

test("the goal badge hides when the goal is cleared", async ({ page }) => {
  // Drive goalactive → the badge appears.
  await drive(page, "goalactive");
  const badge = page.getByTestId("goal-badge");
  await expect(badge).toBeVisible();

  // Drive goalclear → a snapshot with goal:null clears state.goal → badge hides.
  await drive(page, "goalclear");
  await expect(badge).toHaveCount(0);
});

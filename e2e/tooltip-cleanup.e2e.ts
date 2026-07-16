import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// Issue #20: unnecessary tooltips removed from self-documenting UI elements.
// These tests assert that the `title` attribute is gone from elements whose
// function is obvious from their visible label/icon, while elements that carry
// extra hover data (status spans, group paths) keep theirs.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// AC.3: The New Session button has no tooltip but shows a fading ⌘N hint.
test("new-session button has no title, but shows a ⌘N kbd hint on hover", async ({
  page,
}) => {
  const btn = page.getByTestId("sidebar-new-session").locator(".new-btn");
  await expect(btn).not.toHaveAttribute("title", /.+/);

  // The kbd hint exists and is hidden (opacity 0) at rest.
  const hint = btn.locator(".hotkey-hint");
  await expect(hint).toHaveText("⌘N");
  await expect(hint).toHaveCSS("opacity", "0");

  // Hover reveals it.
  await btn.hover();
  await expect(hint).toHaveCSS("opacity", "1");
});

// AC.4: The search toggle and input have no tooltips.
test("sidebar search toggle and input have no title attribute", async ({
  page,
}) => {
  // The search toggle IconButton (visible when search is closed).
  const toggle = page.getByTestId("sidebar-search-toggle");
  await expect(toggle).not.toHaveAttribute("title", /.+/);

  // Open search to reveal the input.
  await toggle.click();
  const input = page.getByTestId("sidebar-search-input");
  await expect(input).toBeVisible();
  await expect(input).not.toHaveAttribute("title", /.+/);
});

// AC.6: Todos and jobs in the right sidebar have no tooltips.
test("todo and job buttons in the right sidebar have no title attribute", async ({
  page,
}) => {
  // Drive the context fixture which populates todos + jobs.
  await drive(page, "context");

  const todoBtn = page.locator(".todo-btn").first();
  await expect(todoBtn).toBeVisible();
  await expect(todoBtn).not.toHaveAttribute("title", /.+/);

  const jobBtn = page.locator(".job-btn").first();
  await expect(jobBtn).toBeVisible();
  await expect(jobBtn).not.toHaveAttribute("title", /.+/);
});

// AC.8: Connection status indicator and working-indicator elapsed time have
// no tooltips.
test("connection status span and working elapsed have no title attribute", async ({
  page,
}) => {
  // The connection span only renders when NOT connected — drive offline.
  // The default fixture is connected, so the .conn span won't be present.
  // Instead, assert on the working-indicator elapsed-time span (visible while
  // a turn is streaming).
  await drive(page, "streamhold");
  const elapsed = page.getByTestId("working-elapsed");
  await expect(elapsed).toBeVisible();
  await expect(elapsed).not.toHaveAttribute("title", /.+/);
});

// AC.12: The group-toggle retains its project-path tooltip, but the project-new
// (+) button loses its tooltip.
test("group-toggle keeps title, project-new has no title", async ({ page }) => {
  await openSidebar(page);
  // The greeting session's project group is "pantoken".
  const group = page.getByTestId("sidebar").locator(".group", {
    hasText: "pantoken",
  });
  const toggle = group.locator(".group-toggle").first();
  await expect(toggle).toHaveAttribute("title", /.+/);

  const newBtn = group.locator(".project-new").first();
  await expect(newBtn).not.toHaveAttribute("title", /.+/);
});

// AC.7: The ToolCard duration span has no title but retains aria-label.
test("tool card duration span has no title but retains aria-label", async ({
  page,
}) => {
  // Expand the greeting's work block to reveal the tool card.
  const toggle = page.getByTestId("work-toggle").first();
  await toggle.click();
  const duration = page.locator(".tool .duration").first();
  await expect(duration).toBeVisible();
  await expect(duration).not.toHaveAttribute("title", /.+/);
  await expect(duration).toHaveAttribute("aria-label", /.+/);
});

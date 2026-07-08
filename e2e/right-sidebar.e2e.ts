import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// The right context panel (RightSidebar) shows the active session's todos,
// background jobs, and flagged files — live session context. Driven by the
// folded session state (flags/todos) and the server's JobsList broadcast (jobs).
// Toggled by the StatusHeader button or ⌘⇧J.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function openPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );
}

test("the context panel renders flagged files and todos", async ({ page }) => {
  // Before driving `context`: panel is closed.
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );

  // Open the panel.
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  // Drive the context fixture → a snapshot with flags + todos lands.
  await drive(page, "context");

  // Flagged files render (AC.1).
  const files = page.getByTestId("flagged-files");
  await expect(files).toBeVisible();
  await expect(files).toContainText("src/app.ts");
  await expect(files).toContainText("README.md");

  // Todos render with titles (AC.2).
  const todos = page.getByTestId("todos");
  await expect(todos).toBeVisible();
  await expect(todos).toContainText("Wire up the right sidebar");
  await expect(todos).toContainText("Add e2e tests");
});

test("the context panel toggles open and closed", async ({ page }) => {
  const toggle = page.getByTestId("context-toggle");
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );

  // Open.
  await toggle.click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  // Close.
  await toggle.click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "false",
  );
});

// AC.7: empty states for all three sections.
test("the context panel shows empty states when no flags/todos/jobs", async ({
  page,
}) => {
  await page.getByTestId("context-toggle").click();
  await expect(page.getByTestId("right-sidebar")).toHaveAttribute(
    "data-open",
    "true",
  );

  // The default mock snapshot has no flags/todos → empty states.
  await expect(page.getByTestId("flagged-files")).toContainText(
    "No flagged files",
  );
  await expect(page.getByTestId("todos")).toContainText("No todos");
  await expect(page.getByTestId("background-jobs")).toContainText(
    "No background jobs",
  );
});

// AC.1: three sections render with the context fixture.
test("three sections render: todos, background jobs, flagged files", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");

  // All three test IDs are visible.
  await expect(page.getByTestId("todos")).toBeVisible();
  await expect(page.getByTestId("background-jobs")).toBeVisible();
  await expect(page.getByTestId("flagged-files")).toBeVisible();
});

// AC.2: clicking a todo opens a detail view with full description + timestamp.
test("clicking a todo opens a detail view with full description", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");

  // Click the first todo.
  await page
    .getByTestId("todos")
    .getByText("Wire up the right sidebar")
    .click();

  // The detail view should appear with the full description.
  const detail = page.getByTestId("todo-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(
    "Add protocol types, event-map threading, and the drawer component",
  );

  // The "Created" meta row should be present (formatRelative output).
  await expect(detail).toContainText("Created");
});

// AC.3: deleting a todo from the detail view removes it from the list.
test("deleting a todo from the detail view removes it", async ({ page }) => {
  await openPanel(page);
  await drive(page, "context");

  // Click "Review with subagent" (todo #3 — no other todo depends on it).
  await page.getByTestId("todos").getByText("Review with subagent").click();
  await expect(page.getByTestId("todo-detail")).toBeVisible();

  // Click delete.
  await page.getByTestId("todo-delete-btn").click();

  // The detail view closes.
  await expect(page.getByTestId("todo-detail")).toHaveCount(0);

  // The todo is no longer in the sidebar (the mock emits a SessionUpdated
  // snapshot with the updated todo list).
  await expect(page.getByTestId("todos")).not.toContainText(
    "Review with subagent",
  );
});

// AC.4: background jobs render with type, status, and output summary.
test("background jobs section renders fixture jobs", async ({ page }) => {
  await openPanel(page);
  await drive(page, "context");

  // The context script populates the mock's job fixtures; the hub broadcasts
  // JobsList on the SessionUpdated.
  const jobs = page.getByTestId("background-jobs");

  // The context fixture has 3 jobs (a running subagent, a completed shell,
  // and a completed subagent).
  await expect(jobs).toContainText("general-purpose");
  await expect(jobs).toContainText("shell_exec");
  await expect(jobs).toContainText("researcher");
});

// AC.5: clicking a job opens a detail view with the output tail.
test("clicking a job opens a detail view with output tail", async ({ page }) => {
  await openPanel(page);
  await drive(page, "context");

  // Wait for jobs to render.
  const jobs = page.getByTestId("background-jobs");
  await expect(jobs).toContainText("general-purpose");

  // Click the first job (the running subagent).
  await jobs.getByText("general-purpose").first().click();

  // The detail view should appear with the output tail.
  const detail = page.getByTestId("job-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Reviewing src/store.svelte.ts");
});

// AC.6: copy-path button on a flagged file copies to clipboard.
test("copy-path button copies flagged file path to clipboard", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");

  // Wait for flagged files to render.
  const files = page.getByTestId("flagged-files");
  await expect(files).toContainText("src/app.ts");

  // Click the copy button for the first file.
  await page.getByTestId("copy-path-src/app.ts").click();

  // Assert the clipboard contains the path.
  const clipboard = await page.evaluate(() =>
    navigator.clipboard.readText(),
  );
  expect(clipboard).toBe("src/app.ts");
});

// AC.8: client-side jobs refresh updates the UI.
test("client-side jobs refresh updates UI after mock script", async ({
  page,
}) => {
  await openPanel(page);
  await drive(page, "context");

  // Wait for default jobs (populated by the context script).
  const jobs = page.getByTestId("background-jobs");
  await expect(jobs).toContainText("general-purpose");
  await expect(jobs).toContainText("researcher");

  // Drive the "jobs" script which swaps the mock's job fixtures.
  await drive(page, "jobs");

  // Drive "idle" to trigger a SessionUpdated → hub re-fetches jobs via
  // on_event → broadcasts JobsList with the "jobs" script's fixtures.
  // (The "idle" script doesn't touch self.jobs, so the swapped fixtures
  // survive.)
  await drive(page, "idle");

  // The new job should appear (its output tail is unique).
  await expect(jobs).toContainText("Investigating the codebase");
  // The old jobs should be gone.
  await expect(jobs).not.toContainText("researcher");
});

import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The Q&A form renders inline in the chat column (role="group" "Questions"), not as
// a floating dialog like the other approvals.
const qnaForm = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Questions" });

test("qna form walks all three card types and submits", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  await expect(
    form.getByText("A few questions before I proceed"),
  ).toBeVisible();
  // It's inline, not a floating sheet.
  await expect(page.getByRole("dialog")).toBeHidden();

  // Q1 — single-select (highlight selection, no radio marker).
  await expect(
    form.getByText("Which package manager should I use?"),
  ).toBeVisible();
  await form.getByRole("radio", { name: /bun/ }).click();
  await form.getByRole("button", { name: "Next" }).click();

  // Q2 — multi-select (checkboxes): two can be picked at once.
  await expect(
    form.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
  await form.getByRole("checkbox", { name: /Typecheck/ }).click();
  await form.getByRole("checkbox", { name: /Lint/ }).click();
  await form.getByRole("button", { name: "Next" }).click();

  // Q3 — free-text.
  await expect(
    form.getByText("Anything else I should know before starting?"),
  ).toBeVisible();
  await form.getByRole("textbox").fill("Please keep commits small.");
  await form.getByRole("button", { name: "Submit" }).click();

  // The form clears, and the submitted answers are surfaced visibly in the
  // transcript (the un-buried `answer` tool result), not hidden in a tool card.
  await expect(qnaForm(page)).toBeHidden();
  await expect(page.getByText("Your answers")).toBeVisible();
  await expect(page.getByText("Please keep commits small.")).toBeVisible();
});

test("qna form: minimize collapses to the title bar and restores", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  const bun = form.getByRole("radio", { name: /bun/ });
  await expect(bun).toBeVisible();

  await form.getByRole("button", { name: "Minimize to the title" }).click();
  // Title stays; the body (options + actions) is hidden.
  await expect(
    form.getByText("A few questions before I proceed"),
  ).toBeVisible();
  await expect(bun).toBeHidden();

  await form.getByRole("button", { name: "Expand the questions" }).click();
  await expect(bun).toBeVisible();
});

test("qna form: Back returns to the previous card", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  await form.getByRole("button", { name: "Next" }).click();
  await expect(
    form.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
  await form.getByRole("button", { name: "Back" }).click();
  await expect(
    form.getByText("Which package manager should I use?"),
  ).toBeVisible();
});

test("qna form: free-text answer preserves its text across choices and questions", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  const field = form.getByPlaceholder("Something else…");
  const bun = form.getByRole("radio", { name: /bun/ });

  // Typing into the free-text field selects it, clearing any preset choice.
  await field.fill("Use the repo default.");
  await expect(bun).toHaveAttribute("aria-checked", "false");

  // Picking a preset switches the selection but keeps the typed text as a draft.
  await bun.click();
  await expect(bun).toHaveAttribute("aria-checked", "true");
  await expect(field).toHaveValue("Use the repo default.");

  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("tab", { name: "Question 1, answered" }).click();
  await expect(field).toHaveValue("Use the repo default.");

  // Focusing the field re-selects the free-text answer over the preset.
  await field.click();
  await expect(bun).toHaveAttribute("aria-checked", "false");
  await expect(field).toHaveValue("Use the repo default.");
});

test("qna form: sidebar can focus another chat and returning restores the draft", async ({
  page,
}) => {
  await drive(page, "qna");
  const field = page.getByPlaceholder("Something else…");
  await field.fill("Keep this while I check another chat.");

  await page.getByText("Explore the fold reducer").click();
  await expect(qnaForm(page)).toBeHidden();
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();

  await page.getByText("Wire up the WebSocket bridge").click();
  await expect(qnaForm(page)).toBeVisible();
  await expect(page.getByPlaceholder("Something else…")).toHaveValue(
    "Keep this while I check another chat.",
  );
});

test("qna form: Cancel dismisses without answering", async ({ page }) => {
  await drive(page, "qna");
  await qnaForm(page).getByRole("button", { name: "Cancel" }).click();
  await expect(qnaForm(page)).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

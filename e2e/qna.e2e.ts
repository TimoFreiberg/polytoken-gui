import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("qna form walks all three card types and submits", async ({ page }) => {
  await drive(page, "qna");
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("A few questions before I proceed"),
  ).toBeVisible();

  // Q1 — single-select (radio).
  await expect(
    dialog.getByText("Which package manager should I use?"),
  ).toBeVisible();
  await dialog.getByRole("radio", { name: /bun/ }).click();
  await dialog.getByRole("button", { name: "Next" }).click();

  // Q2 — multi-select (checkboxes): two can be picked at once.
  await expect(
    dialog.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
  await dialog.getByRole("checkbox", { name: /Typecheck/ }).click();
  await dialog.getByRole("checkbox", { name: /Lint/ }).click();
  await dialog.getByRole("button", { name: "Next" }).click();

  // Q3 — free-text.
  await expect(
    dialog.getByText("Anything else I should know before starting?"),
  ).toBeVisible();
  await dialog.getByRole("textbox").fill("Please keep commits small.");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Recorded 3 answers.")).toBeVisible();
});

test("qna form: Back returns to the previous card", async ({ page }) => {
  await drive(page, "qna");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(
    dialog.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(
    dialog.getByText("Which package manager should I use?"),
  ).toBeVisible();
});

test("qna form: free-text answer preserves its text across choices and questions", async ({
  page,
}) => {
  await drive(page, "qna");
  const dialog = page.getByRole("dialog");
  const field = dialog.getByPlaceholder("Something else…");
  const bun = dialog.getByRole("radio", { name: /bun/ });

  // Typing into the free-text field selects it, clearing any preset choice.
  await field.fill("Use the repo default.");
  await expect(bun).toHaveAttribute("aria-checked", "false");

  // Picking a preset switches the selection but keeps the typed text as a draft.
  await bun.click();
  await expect(bun).toHaveAttribute("aria-checked", "true");
  await expect(field).toHaveValue("Use the repo default.");

  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("tab", { name: "Question 1, answered" }).click();
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
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();

  await page.getByText("Wire up the WebSocket bridge").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByPlaceholder("Something else…")).toHaveValue(
    "Keep this while I check another chat.",
  );
});

test("qna form: Cancel dismisses without answering", async ({ page }) => {
  await drive(page, "qna");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

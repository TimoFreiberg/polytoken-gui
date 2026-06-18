import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a streamed reply renders user text, assistant text, and a tool call", async ({
  page,
}) => {
  await drive(page, "reply");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await expect(
    page.getByText("Here's the plan", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Read file")).toBeVisible();
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
});

test("a thinking block appears and expands", async ({ page }) => {
  await drive(page, "reply");
  const think = page.getByText("Thought process");
  await expect(think).toBeVisible();
  await think.click();
  await expect(
    page.getByText("Let me think about the cleanest way", { exact: false }),
  ).toBeVisible();
});

test("typing a prompt then sending clears the composer", async ({ page }) => {
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("hello there");
  await box.press("Enter");
  await expect(page.getByText("hello there")).toBeVisible();
  await expect(box).toHaveValue("");
});

test("run-failed shows an error card whose Retry re-sends the last prompt", async ({
  page,
}) => {
  // Send a prompt so there's a "last prompt" to retry.
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("run the failing thing");
  await box.press("Enter");
  await expect(page.getByText("run the failing thing")).toHaveCount(1);

  // Drive a run-failure → a distinct error card with the message.
  await drive(page, "error");
  const notice = page.locator(".notice.error");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("529 overloaded");

  // Retry re-sends the last prompt → a second user message with that text appears.
  await notice.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("run the failing thing")).toHaveCount(2);
});

test("Enter steers and Alt+Enter queues a follow-up while streaming", async ({
  page,
}) => {
  await drive(page, "streamhold"); // a turn that stays running
  const modes = page.locator(".composer-wrap .modes");
  await expect(modes).toBeVisible();
  // The hotkey hint is shown alongside the steer/follow-up toggle.
  await expect(
    page.getByText("queues a follow-up", { exact: false }),
  ).toBeVisible();

  const box = page.getByPlaceholder("Queue a message…");
  // Alt+Enter queues a follow-up — the toggle reflects the choice and the draft clears.
  await box.fill("do this after");
  await box.press("Alt+Enter");
  await expect(modes.getByRole("button", { name: "follow-up" })).toHaveClass(
    /active/,
  );
  await expect(box).toHaveValue("");

  // Plain Enter steers.
  await box.fill("actually now");
  await box.press("Enter");
  await expect(
    modes.getByRole("button", { name: "steer", exact: true }),
  ).toHaveClass(/active/);
});

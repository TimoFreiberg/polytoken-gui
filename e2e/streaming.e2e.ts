import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a streamed reply renders user text, a working block, and the final answer", async ({
  page,
}) => {
  await drive(page, "reply");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  // The turn settles with its final answer visible…
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
  // …and its narration + tool collapse into the "Worked for Ns" block — reveal them.
  await expandWork(page);
  await expect(
    page.getByText("Here's the plan", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Read file")).toBeVisible();
});

test("thinking stays hidden by default even inside an expanded working block", async ({
  page,
}) => {
  await drive(page, "reply");
  // The turn's final answer lands, proving it ran…
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
  // …and even with the working block expanded, the thinking is gone entirely (hidden by
  // the default-on Settings toggle): no collapsed head, no reasoning text.
  await expandWork(page);
  await expect(page.getByText("Thought process")).toHaveCount(0);
  await expect(
    page.getByText("Let me think about the cleanest way", { exact: false }),
  ).toHaveCount(0);
});

test("disabling Hide thinking reveals the expandable thinking block", async ({
  page,
}) => {
  // Turn the (default-on) hide-thinking toggle off via Settings.
  await page.getByTestId("settings-toggle").click();
  const toggle = page.getByTestId("hide-thinking");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  await drive(page, "reply");
  // The thinking block lives in the turn's working section — settle, then expand it.
  await expect(
    page.getByText("That confirms it", { exact: false }),
  ).toBeVisible();
  await expandWork(page);
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
  // The steer/follow-up switch is now the shared SegmentedControl (a radiogroup of
  // radios, matching Settings' theme switch) — select it by its accessible name.
  const modes = page.getByRole("radiogroup", { name: "Delivery mode" });
  await expect(modes).toBeVisible();
  // The hotkey hint is shown alongside the steer/follow-up toggle.
  await expect(
    page.getByText("queues a follow-up", { exact: false }),
  ).toBeVisible();

  const box = page.getByPlaceholder("Queue a message…");
  // Alt+Enter queues a follow-up — the toggle reflects the choice and the draft clears.
  await box.fill("do this after");
  await box.press("Alt+Enter");
  await expect(modes.getByRole("radio", { name: "follow-up" })).toHaveClass(
    /active/,
  );
  await expect(box).toHaveValue("");

  // Plain Enter steers.
  await box.fill("actually now");
  await box.press("Enter");
  await expect(
    modes.getByRole("radio", { name: "steer", exact: true }),
  ).toHaveClass(/active/);
});

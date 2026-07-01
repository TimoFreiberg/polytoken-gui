import { expect, test } from "@playwright/test";
import { drive, expandWork, gotoFresh, openSettings } from "./helpers.js";

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
  // Wait for the turn to actually settle before expanding: "That confirms it" is the
  // reply's final text, but `runCompleted` lands ~80ms later. Until the turn ends it
  // isn't collapsible, so `expandWork`'s "last toggle" would target the greeting's
  // block instead (the greeting never goes running, so the indicator is the reply's).
  await expect(page.getByTestId("working-indicator")).toHaveCount(0);
  // …and its narration + tool collapse into the "Worked for Ns" block — reveal them.
  await expandWork(page);
  await expect(
    page.getByText("Here's the plan", { exact: false }),
  ).toBeVisible();
  // Scope to THIS turn's work block: the greeting turn also renders a (collapsed) tool
  // summary, so an unscoped `.tool.summary` could match both and trip strict mode.
  const summary = page
    .locator(".turn-work")
    .last()
    .getByTestId("work-body")
    .locator(".tool.summary");
  await expect(summary.locator(":scope > .head .label")).toHaveText(
    "Read a file",
  );
});

test("streaming text reveals with a fade wrapper; settled history stays static", async ({
  page,
}) => {
  // gotoFresh already waited for the greeting turn to settle. Settled / historical
  // assistant blocks must render statically — markstream's `.fade-node` reveal wrapper
  // is scoped to the live-streaming turn only (Markdown `fade` prop), so none survive
  // on settled content. A regression that drops the scoping would fade the whole
  // transcript on every load / session switch / scroll-in.
  await expect(
    page.locator(".row.assistant .node-content.fade-node"),
  ).toHaveCount(0);

  // Drive a turn that stays open → its live assistant paragraph carries the fade-node
  // reveal wrapper while it streams (streamHold never emits runCompleted, so the class
  // persists and the assertion can't race a settle).
  await drive(page, "streamhold");
  await expect(page.getByText("Working on it", { exact: false })).toBeVisible();
  await expect(
    page.locator(".row.assistant .node-content.fade-node"),
  ).not.toHaveCount(0);
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
  await openSettings(page, "appearance");
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
  // The live turn renders inline and only collapses into its "Worked for Ns" work block
  // once it settles. Wait for the reply's work toggle to join the greeting's (count 2)
  // so expanding + clicking the thinking block can't race the inline→collapsed reflow.
  await expect(page.getByTestId("work-toggle")).toHaveCount(2);
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

test("run-failed shows an error card whose Resume sends continue", async ({
  page,
}) => {
  // Send a prompt so the scenario reflects a real accepted-then-failed turn.
  const box = page.getByPlaceholder("Message pilot…");
  await box.fill("run the failing thing");
  await box.press("Enter");
  await expect(page.getByText("run the failing thing")).toHaveCount(1);

  // Drive a run-failure → a distinct error card with the message.
  await drive(page, "error");
  const notice = page.locator(".notice.error");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("529 overloaded");

  // The error notice shows a Resume button (not Retry) — the prior prompt was
  // already accepted by the daemon (runFailed only fires after the turn started),
  // so re-sending it verbatim would be wasteful. Resume sends "continue".
  await expect(notice.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Resume sends a "continue" signal → a new user message appears in the transcript.
  await notice.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("continue")).toHaveCount(1);
  // The original prompt is NOT re-sent — it's already in the daemon's history.
  await expect(page.getByText("run the failing thing")).toHaveCount(1);
});

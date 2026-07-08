import { expect, test } from "@playwright/test";
import { driveLive, gotoFreshLive } from "./helpers.js";

// LIVE tier (PANTOKEN_DRIVER=fake). See streaming.e2e.ts for the structural-only +
// unrun-in-session caveats.

test.beforeEach(async ({ page }) => {
  await gotoFreshLive(page);
});

test("an ask_user_question interrogative renders the inline Q&A form", async ({
  page,
}) => {
  await driveLive(page, "ask");

  // The ask-user-question corpus raises a qna interrogative → the inline Q&A form
  // (role=group "Questions", rendered in the chat column, not a floating dialog).
  // Question text is corpus-specific, so we assert the form's presence + that it
  // exposes an advance/submit control the operator can act on.
  const form = page.getByRole("group", { name: "Questions" });
  await expect(form).toBeVisible();
  await expect(
    form.getByRole("button", { name: /Next|Submit/ }).first(),
  ).toBeVisible();
});

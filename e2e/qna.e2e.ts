import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSettings } from "./helpers.js";

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
  await form.getByRole("button", { name: "Review answers" }).click();

  // Summary page: review before the no-undo confirm.
  await expect(form.getByText("Review your answers")).toBeVisible();
  await form.getByRole("button", { name: "Confirm" }).click();

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

test("qna form: free-text answer is additive and preserves its text across choices and questions", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  const field = form.getByPlaceholder("Something else…");
  const bun = form.getByRole("radio", { name: /bun/ });

  // Free-text is additive: typing alongside a choice does not clear the radio.
  await bun.click();
  await expect(bun).toHaveAttribute("aria-checked", "true");
  await field.fill("Use the repo default.");
  // The radio stays selected — both will be sent together.
  await expect(bun).toHaveAttribute("aria-checked", "true");
  await expect(field).toHaveValue("Use the repo default.");

  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("tab", { name: "Question 1, answered" }).click();
  await expect(field).toHaveValue("Use the repo default.");
  // The radio is still selected after navigating away and back.
  await expect(bun).toHaveAttribute("aria-checked", "true");
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

test("qna form renders markdown in the context field", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  // The context field now renders markdown. The mock's Q1 context contains
  // `bun.lock` (inline code) and **Note:** (bold). Assert both render as HTML.
  const ctx = form.locator(".ctx");
  await expect(ctx).toBeVisible();
  // Multiple inline code spans exist — assert at least one is present.
  await expect(ctx.locator("code").first()).toBeVisible();
  await expect(ctx.locator("strong")).toBeVisible();
});

test("qna form: Cancel dismisses without answering", async ({ page }) => {
  await drive(page, "qna");
  await qnaForm(page).getByRole("button", { name: "Cancel" }).click();
  // First click arms the confirm gate — label switches to "Click again".
  await expect(qnaForm(page).getByRole("button", { name: "Click again" })).toBeVisible();
  await qnaForm(page).getByRole("button", { name: "Click again" }).click();
  await expect(qnaForm(page)).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("qna Cancel uses a click-twice confirm gate", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);

  // ── AC.1: first click arms, does not dismiss ──────────────────
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Click again" })).toBeVisible();
  // Form is still visible (not dismissed).
  await expect(form).toBeVisible();

  // ── AC.6: armed button carries the .armed class + danger color ─
  const armedBtn = form.getByRole("button", { name: "Click again" });
  await expect(armedBtn).toHaveClass(/\bbtn\b.*\barmed\b/);
  const dangerColor = await page.evaluate(() => {
    const el = document.querySelector(".qna .actions .btn.armed") as HTMLElement | null;
    return el ? getComputedStyle(el).color : null;
  });
  expect(dangerColor).not.toBeNull();
  // The --danger CSS variable must resolve to a non-transparent color.
  expect(dangerColor).toMatch(/rgb|rgba|hsl|hsla/);

  // Second click fires the cancel.
  await armedBtn.click();
  await expect(form).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("qna Cancel armed state auto-disarms after 3s", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);

  // Arm the cancel gate.
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Click again" })).toBeVisible();

  // AC.3: poll until the label reverts to "Cancel" (the 3s timer fires).
  await expect
    .poll(async () => {
      const btn = form.getByRole("button", { name: /Cancel|Click again/ });
      return await btn.textContent();
    }, { timeout: 4500 })
    .toBe("Cancel");

  // The button is back to its un-armed state — a click now arms again, not cancels.
  await expect(form).toBeVisible();
});

test("qna Cancel armed state resets on question navigation", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);

  // Arm the cancel gate on Q1.
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Click again" })).toBeVisible();

  // AC.5: navigating to the next question disarms — the Cancel label returns.
  await form.getByRole("button", { name: "Next" }).click();
  await expect(form.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Click again" })).toBeHidden();
});

test("qna Cancel Esc disarms when armed without cancelling", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);

  // Arm the cancel gate.
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form.getByRole("button", { name: "Click again" })).toBeVisible();

  // AC.4: Esc while armed disarms (label reverts) without cancelling.
  await page.keyboard.press("Escape");
  await expect(form.getByRole("button", { name: "Cancel" })).toBeVisible();
  // The form is still visible (Esc did NOT cancel).
  await expect(form).toBeVisible();
});

test("qna question text scales with --font-scale; action buttons do not", async ({
  page,
}) => {
  // The Q&A widget renders outside the Transcript's scaled `.col`, so it used to
  // miss font scaling entirely. Now `.qna-inline` carries a scaled base and the
  // form's text rules are in `em`, so reading text tracks --font-scale while the
  // action buttons (Button.svelte, chrome) stay at body size.
  await drive(page, "qna");
  const form = qnaForm(page);
  const q = form.locator(".q");
  const submit = form.getByRole("button", { name: "Review answers" });
  // Surface the Review button (last question on the 3-card walk).
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("button", { name: "Next" }).click();
  await expect(submit).toBeVisible();

  const qSize = async () =>
    Number.parseFloat(await q.evaluate((el) => getComputedStyle(el).fontSize));
  const btnSize = async () =>
    Number.parseFloat(
      await submit.evaluate((el) => getComputedStyle(el).fontSize),
    );

  // At default scale the question text is ~15px (1em of the 15px base).
  const baseQ = await qSize();
  expect(baseQ).toBeCloseTo(15, 0);
  const baseBtn = await btnSize();

  // Bump the scale via the real Settings stepper; question text grows.
  await openSettings(page, "appearance");
  const panel = page.getByTestId("settings-panel");
  await panel.getByTestId("font-larger").click();
  await panel.getByTestId("font-larger").click();
  // Close settings so the form is interactable/visible again. Assert the panel
  // actually closed: Escape routes to the focused stepper button (inside Settings,
  // not the Q&A form's `.qna` keydown), so it closes Settings without cancelling
  // the form — but make that invariant explicit so a future refactor promoting
  // either handler to window-scope surfaces a clear "settings didn't close" error
  // instead of a confusing "font-size didn't grow" failure.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  const grownQ = await qSize();
  expect(grownQ).toBeGreaterThan(baseQ);

  // The Review button's font-size is unchanged (controls stay unscaled).
  const grownBtn = await btnSize();
  expect(grownBtn).toBeCloseTo(baseBtn, 0);
});

test("qna form: context scrolls, options and actions stay in viewport, form caps at 70vh", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);

  // The card itself does NOT scroll on desktop (overflow is hidden,
  // not auto/scroll — only .ctx scrolls).
  const card = form.locator(".card");
  const cardOverflow = await card.evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(cardOverflow).toBe("hidden");

  // ── Q1: single-select with context ──────────────────────────
  // The context (.ctx) is the sole scroll region on desktop.
  const ctx = form.locator(".ctx");
  await expect(ctx).toBeVisible();
  const ctxOverflow = await ctx.evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(["auto", "scroll"]).toContain(ctxOverflow);

  // All option buttons (radios for Q1) are in the viewport — not scrolled away.
  // toBeInViewport() verifies actual viewport intersection, not just DOM presence.
  await expect(form.getByRole("radio", { name: /bun/ })).toBeInViewport();
  await expect(form.getByRole("radio", { name: /\bnpm\b/ })).toBeInViewport();
  await expect(form.getByRole("radio", { name: /pnpm/ })).toBeInViewport();

  // Action buttons are in the viewport.
  await expect(form.getByRole("button", { name: "Cancel" })).toBeInViewport();
  await expect(form.getByRole("button", { name: "Next" })).toBeInViewport();

  // ── Q2: multi-select, no context ────────────────────────────
  await form.getByRole("button", { name: "Next" }).click();
  // No .ctx on Q2 — .card is just .q + .opts. Card still doesn't scroll.
  const cardOverflowQ2 = await card.evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(cardOverflowQ2).toBe("hidden");
  // All four checkboxes are in the viewport.
  await expect(form.getByRole("checkbox", { name: /Typecheck/ })).toBeInViewport();
  await expect(form.getByRole("checkbox", { name: /Unit tests/ })).toBeInViewport();
  await expect(form.getByRole("checkbox", { name: /Lint/ })).toBeInViewport();
  await expect(form.getByRole("checkbox", { name: /e2e/ })).toBeInViewport();
  // Back button appears on Q2 (current > 0) — assert it's in viewport too.
  await expect(form.getByRole("button", { name: "Back" })).toBeInViewport();

  // ── Q3: free-text textarea, no context, no options ─────────
  await form.getByRole("button", { name: "Next" }).click();
  // No .ctx, no .opts — .card is just .q + .field.area textarea.
  const cardOverflowQ3 = await card.evaluate(
    (el) => getComputedStyle(el).overflowY,
  );
  expect(cardOverflowQ3).toBe("hidden");
  // The textarea is in the viewport (not clipped by .card's overflow:hidden).
  await expect(form.getByRole("textbox")).toBeInViewport();
  await expect(form.getByRole("button", { name: "Review answers" })).toBeInViewport();

  // ── Form height cap ─────────────────────────────────────────
  // getComputedStyle resolves vh to px, so compute the expected px from
  // the viewport height and compare. The form's rendered height must not
  // exceed 70vh.
  const inline = page.locator(".qna-inline");
  const vh = await page.evaluate(() => window.innerHeight);
  const box = await inline.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(vh * 0.7 + 1); // +1px tolerance
});

test("qna form: Enter advances through questions to summary and confirms", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  // Focus the form container so Enter (whose target is the div) advances.
  await form.focus();

  // Q1 (no selection) → Enter advances to Q2.
  await page.keyboard.press("Enter");
  await expect(
    form.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
  // Q2 → Enter advances to Q3.
  await page.keyboard.press("Enter");
  await expect(
    form.getByText("Anything else I should know before starting?"),
  ).toBeVisible();
  // Q3 — type a free-text answer, then Enter → summary.
  await form.getByRole("textbox").fill("Keep commits small.");
  await page.keyboard.press("Enter");
  await expect(form.getByText("Review your answers")).toBeVisible();
  // Summary → Enter confirms and submits.
  await page.keyboard.press("Enter");

  await expect(qnaForm(page)).toBeHidden();
  await expect(page.getByText("Your answers")).toBeVisible();
  await expect(page.getByText("Keep commits small.")).toBeVisible();
});

test("qna form: Enter advances after a mouse selection", async ({ page }) => {
  // Clicking an option button focuses it in Chromium; the next Enter must
  // still advance (pickSingle returns focus to the container).
  await drive(page, "qna");
  const form = qnaForm(page);
  await form.getByRole("radio", { name: /bun/ }).click();
  await page.keyboard.press("Enter");
  await expect(
    form.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
});

test("qna form: Shift+Enter inserts a newline in free-text field", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  // Advance to Q3 (free-text card).
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("button", { name: "Next" }).click();
  const ta = form.getByRole("textbox");
  const beforeH = await ta.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el as HTMLElement).height),
  );
  await ta.click();
  await ta.fill("first line");
  // Shift+Enter inserts a newline (the handler lets the browser handle it).
  await page.keyboard.press("Shift+Enter");
  await ta.pressSequentially("second line");
  // The value contains a newline.
  await expect(ta).toHaveValue("first line\nsecond line");
  // The textarea grew to fit the second line.
  const afterH = await ta.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el as HTMLElement).height),
  );
  expect(afterH).toBeGreaterThan(beforeH);
});

test("qna form: free-text textarea auto-grows and caps", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("button", { name: "Next" }).click();
  const ta = form.getByRole("textbox");
  await ta.click();
  // The cap is max(60, min(winH*0.2, 140))px.
  const maxFieldH = await page.evaluate(() =>
    Math.max(60, Math.min(window.innerHeight * 0.2, 140)),
  );
  const initialScroll = await ta.evaluate((el) => el.scrollHeight);
  // Type many lines via Shift+Enter to force growth past one line.
  await ta.pressSequentially("line one");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Enter");
    await ta.pressSequentially(`line ${i + 2}`);
  }
  const grownScroll = await ta.evaluate((el) => el.scrollHeight);
  expect(grownScroll).toBeGreaterThan(initialScroll);
  // Computed height never exceeds the cap.
  const computedH = await ta.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el as HTMLElement).height),
  );
  expect(computedH).toBeLessThanOrEqual(maxFieldH + 1); // +1px tolerance
});

test("qna form: single-select free-text is additive with selected option", async ({
  page,
}) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  const bun = form.getByRole("radio", { name: /bun/ });
  const field = form.getByPlaceholder("Something else…");
  await bun.click();
  await expect(bun).toHaveAttribute("aria-checked", "true");
  // Typing alongside the choice does NOT clear the radio — both are sent.
  await field.fill("Use the repo default.");
  await expect(bun).toHaveAttribute("aria-checked", "true");

  // Advance through the remaining questions to reach the summary.
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("button", { name: "Review answers" }).click();
  await expect(form.getByText("Review your answers")).toBeVisible();
  await form.getByRole("button", { name: "Confirm" }).click();

  await expect(qnaForm(page)).toBeHidden();
  await expect(page.getByText("Your answers")).toBeVisible();
  // The mock's format_qna_text renders both as "bun, (typed) Use the repo default."
  await expect(
    page.getByText("bun, (typed) Use the repo default."),
  ).toBeVisible();
});

test("qna form: summary page shows all answers", async ({ page }) => {
  await drive(page, "qna");
  const form = qnaForm(page);
  // Q1 — pick bun.
  await form.getByRole("radio", { name: /bun/ }).click();
  // Q2 — multi-select two checks.
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("checkbox", { name: /Typecheck/ }).click();
  await form.getByRole("checkbox", { name: /Lint/ }).click();
  // Q3 — free-text.
  await form.getByRole("button", { name: "Next" }).click();
  await form.getByRole("textbox").fill("Please keep commits small.");

  await form.getByRole("button", { name: "Review answers" }).click();
  await expect(form.getByText("Review your answers")).toBeVisible();
  // Each question + its answer is visible. Scope to .summary so the assertions
  // don't collide with the editing card's .q text during the reveal transition.
  const summary = form.locator(".summary");
  await expect(
    summary.getByText("Which package manager should I use?"),
  ).toBeVisible();
  await expect(summary.getByText("bun")).toBeVisible();
  await expect(
    summary.getByText("Which checks should run before each commit?"),
  ).toBeVisible();
  await expect(summary.getByText("Typecheck")).toBeVisible();
  await expect(summary.getByText("Lint")).toBeVisible();
  await expect(
    summary.getByText("Anything else I should know before starting?"),
  ).toBeVisible();
  await expect(summary.getByText("Please keep commits small.")).toBeVisible();

  // Back returns to the last question (Q3 card reappears). The summary's Back
  // is disambiguated from the editing Back by its title (both read "Back").
  await form.getByTitle("Back to editing (←)").click();
  await expect(
    form.locator(".card").getByText("Anything else I should know before starting?"),
  ).toBeVisible();

  // Review again → Confirm submits.
  await form.getByRole("button", { name: "Review answers" }).click();
  await form.getByRole("button", { name: "Confirm" }).click();
  await expect(qnaForm(page)).toBeHidden();
  await expect(page.getByText("Your answers")).toBeVisible();
});

test("qna form: scroll position is independent per page", async ({ page }) => {
  await drive(page, "qnatall");
  const form = qnaForm(page);
  const ctx = form.locator(".ctx");

  // Q1: scroll the context down.
  await expect(ctx).toBeVisible();
  await ctx.evaluate((el) => (el.scrollTop = el.scrollHeight));
  // Verify it actually scrolled (context is tall enough to overflow).
  const q1Scroll = await ctx.evaluate((el) => el.scrollTop);
  expect(q1Scroll).toBeGreaterThan(100);

  // Advance to Q2 — its context should start at the top. The scroll reset
  // runs in a requestAnimationFrame inside QnaForm's $effect, so poll until
  // it lands at 0 rather than reading it synchronously (which could race the
  // rAF and observe the carried-over scroll from Q1).
  await form.getByRole("button", { name: "Next" }).click();
  await expect(
    form.getByText("Pick the second option (long context)"),
  ).toBeVisible();
  await expect
    .poll(async () => await ctx.evaluate((el) => el.scrollTop), {
      timeout: 1000,
      message: "Q2 context should start scrolled to top",
    })
    .toBe(0);

  // Scroll Q2 down, go back to Q1 — Q1 should also start at the top
  // (Q2's scroll must not have leaked into Q1).
  await ctx.evaluate((el) => (el.scrollTop = el.scrollHeight));
  // Verify Q2 actually scrolled (same long context as Q1).
  const q2Scroll = await ctx.evaluate((el) => el.scrollTop);
  expect(q2Scroll).toBeGreaterThan(100);

  await form.getByRole("button", { name: "Back" }).click();
  await expect(
    form.getByText("Pick the first option (long context)"),
  ).toBeVisible();
  await expect
    .poll(async () => await ctx.evaluate((el) => el.scrollTop), {
      timeout: 1000,
      message: "Q1 context should start scrolled to top after back-nav",
    })
    .toBe(0);
});

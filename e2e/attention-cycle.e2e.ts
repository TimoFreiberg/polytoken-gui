import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSettings } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

// The inline Q&A form renders as role="group" named "Questions".
const qnaForm = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Questions" });

test("⌘\\ cycles through qna + approval: transcript → qna → approval → transcript", async ({
  page,
}) => {
  // Drive qna first, wait for its form to be visible, THEN drive confirm — the
  // explicit wait-between-drives is required because MockDriver.play() flushes any
  // in-flight script before starting a new one; without it, the qna can be dropped.
  await drive(page, "qna");
  await expect(qnaForm(page)).toBeVisible();
  await drive(page, "confirm");
  // Both are now active: the qna form inline + the confirm sheet floating.
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();

  // Press 1: transcript(home) → qna. First press from home advances TO qna —
  // nothing is minimized yet (no previous surface to collapse). Both still visible.
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".attention-pill")).toHaveCount(0);
  await expect(qnaForm(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Press 2: qna → approval. Qna minimizes to a pill, approval sheet stays visible.
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".attention-pill")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();

  // Press 3: approval → transcript. Approval also minimizes to a pill.
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".attention-pill")).toHaveCount(2);
  await expect(page.getByRole("dialog")).toBeHidden();

  // Press 4: transcript → qna. Qna restores (its pill disappears); approval pill remains.
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".attention-pill")).toHaveCount(1);
  await expect(qnaForm(page)).toBeVisible();
});

test("clicking a pill restores its surface", async ({ page }) => {
  await drive(page, "confirm");
  await expect(page.getByRole("dialog")).toBeVisible();

  // Press 1: home → approval (no pill yet, approval is the target).
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".attention-pill")).toHaveCount(0);

  // Press 2: approval → transcript. Approval minimizes to a pill.
  await page.keyboard.press("Control+\\");
  const pill = page.locator(".attention-pill").first();
  await expect(pill).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Click the pill → the sheet restores.
  await pill.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(pill).toBeHidden();
});

test("⌘\\ is a no-op when no agent-driven surfaces are active", async ({ page }) => {
  // Clean transcript — no pending approvals/qna. ⌘\ should do nothing.
  await expect(page.locator(".attention-pill")).toHaveCount(0);
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".attention-pill")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("⌘\\ does not fire when a user-driven modal (Settings) is open", async ({
  page,
}) => {
  await drive(page, "confirm");
  await expect(page.getByRole("dialog")).toBeVisible();

  // Open Settings (a user-driven modal) — it should own the keyboard.
  await openSettings(page);
  await expect(page.getByTestId("settings-panel")).toBeVisible();

  // ⌘\ should be a no-op: the approval sheet stays visible, no pill appears.
  await page.keyboard.press("Control+\\");
  await expect(page.getByRole("dialog", { name: "Run destructive command?" })).toBeVisible();
  await expect(page.locator(".attention-pill")).toHaveCount(0);
});

test("approval pill has a title attribute naming the action + hotkey", async ({
  page,
}) => {
  await drive(page, "confirm");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Control+\\");
  await page.keyboard.press("Control+\\");
  const pill = page.locator(".attention-pill").first();
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("title", /restore/);
});

test("Esc still cancels a visible (non-minimized) approval dialog (regression)", async ({
  page,
}) => {
  await drive(page, "confirm");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Dialog cancelled.")).toBeVisible();
});

test("the minimize button in the approval sheet has title + aria-expanded", async ({
  page,
}) => {
  await drive(page, "confirm");
  const minBtn = page.getByRole("button", { name: /minimize/i });
  await expect(minBtn).toBeVisible();
  await expect(minBtn).toHaveAttribute("aria-expanded", "true");
  await expect(minBtn).toHaveAttribute("title", /⌘\\/);

  // Clicking it minimizes to a pill.
  await minBtn.click();
  await expect(page.locator(".attention-pill").first()).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
});

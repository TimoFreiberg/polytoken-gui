import { expect, test } from "@playwright/test";
import { gotoFresh, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
});

test("mobile centres the deferred draft and keeps its controls usable", async ({
  page,
}) => {
  const view = page.getByTestId("new-session");
  const composer = view.getByRole("group", { name: "Message composer" });
  const viewBox = await view.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(viewBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  const centre = composerBox!.y + composerBox!.height / 2;
  const relativeCentre = (centre - viewBox!.y) / viewBox!.height;
  expect(relativeCentre).toBeGreaterThan(0.3);
  expect(relativeCentre).toBeLessThan(0.58);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
    viewBox!.y + viewBox!.height + 0.5,
  );

  await page.getByTestId("draft-project-control").click();
  await expect(
    page.getByRole("dialog", { name: "Choose project directory" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("mobile-session-controls-trigger").click();
  await expect(
    page.getByRole("dialog", { name: "Session controls" }),
  ).toBeVisible();
});

test("mobile keyboard inset keeps a long draft bounded above the keyboard", async ({
  page,
}) => {
  const input = page.getByPlaceholder("Describe a task or ask a question…");
  await input.fill(
    Array.from({ length: 24 }, (_, i) => `A useful long line ${i + 1}`).join(
      "\n",
    ),
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--keyboard-inset", "260px"),
  );

  const shell = page.locator(".shell");
  const view = page.getByTestId("new-session");
  const composer = page.getByRole("group", { name: "Message composer" });
  await expect
    .poll(() => shell.evaluate((el) => el.clientHeight))
    .toBeLessThan(600);
  const shellBox = await shell.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(shellBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y).toBeGreaterThanOrEqual(shellBox!.y - 0.5);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
    shellBox!.y + shellBox!.height + 0.5,
  );
  await expect(view).toHaveCSS("overflow-y", "auto");
  await expect(input).toHaveCSS("overflow-y", "auto");
});

test("mobile navigation leaves the draft without discarding its text", async ({
  page,
}) => {
  const input = page.getByPlaceholder("Describe a task or ask a question…");
  await input.fill("keep this idea");
  await openSidebar(page);
  await page.getByText("Wire up the WebSocket bridge", { exact: true }).click();
  await openSidebar(page);
  await page.getByRole("button", { name: "New session…" }).click();
  await expect(
    page.getByPlaceholder("Describe a task or ask a question…"),
  ).toHaveValue("keep this idea");
});

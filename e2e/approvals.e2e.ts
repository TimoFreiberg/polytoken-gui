import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("confirm dialog: Allow resolves and surfaces a notice", async ({
  page,
}) => {
  await drive(page, "confirm");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Run destructive command?")).toBeVisible();
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Approved — continuing.")).toBeVisible();
});

test("confirm dialog: Deny resolves with the deny notice", async ({ page }) => {
  await drive(page, "confirm");
  await page.getByRole("dialog").getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Denied — skipping that step.")).toBeVisible();
});

test("project-trust card renders all five options + the cwd", async ({
  page,
}) => {
  await drive(page, "trust");
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("/Users/timo/src/untrusted-repo"),
  ).toBeVisible();
  for (const opt of [
    "Trust this folder",
    "Trust parent folder",
    "Trust for this session only",
    "Don't trust",
    "Don't trust (this session)",
  ]) {
    await expect(
      dialog.getByRole("button", { name: opt, exact: true }),
    ).toBeVisible();
  }
});

test("project-trust card: choosing an option dismisses it + confirms", async ({
  page,
}) => {
  await drive(page, "trust");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Trust this folder", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Trust decision recorded")).toBeVisible();
});

test("input dialog submits a value", async ({ page }) => {
  await drive(page, "input");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Commit message")).toBeVisible();
  await dialog.getByRole("textbox").fill("My commit");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Received: My commit")).toBeVisible();
});

test("ambient: status strip and a todo widget appear", async ({ page }) => {
  await drive(page, "ambient");
  await expect(page.getByText("on main · 2 files changed")).toBeVisible();
  await expect(page.getByText("add /health")).toBeVisible();
});

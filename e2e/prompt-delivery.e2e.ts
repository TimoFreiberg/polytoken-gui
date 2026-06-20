import { expect, test } from "@playwright/test";
import { gotoFresh, waitForSettledWorkBlocks } from "./helpers.js";

test("an offline prompt survives page loss and sends once after reconnect", async ({
  context,
  page,
}) => {
  await gotoFresh(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pilot:test-disconnect")),
  );
  await expect(page.getByText("Offline — the agent keeps running")).toBeVisible();

  const prompt = "deliver this exactly once after reconnect";
  const composer = page.getByPlaceholder("Message pilot…");
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(composer).toHaveValue("");
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByText("Queued offline", { exact: true })).toBeVisible();

  // Simulate a tab eviction while still offline. IndexedDB outlives the page; the
  // reopened client hydrates the outbox after authenticated hello and retries it.
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/?dev");

  await waitForSettledWorkBlocks(reopened, 2);
  await expect(reopened.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(
    reopened.getByText("Queued offline", { exact: true }),
  ).toHaveCount(0);
});

test("a rejected prompt stays visible and can be returned to the composer", async ({
  page,
}) => {
  await gotoFresh(page);
  const prompt = "__pilot_reject_prompt__";
  const composer = page.getByPlaceholder("Message pilot…");
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Not sent — Mock prompt rejected before acceptance",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(composer).toHaveValue(prompt);
  await expect(page.getByText("Not sent", { exact: false })).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

const BG = "Explore the fold reducer";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a background approval stays obvious and opens the right session", async ({
  page,
}) => {
  await openSidebar(page);
  await drive(page, "bgwait");

  const sidebar = page.getByTestId("sidebar");
  const row = sidebar.locator(".row", { hasText: BG });
  const status = row.getByTestId("session-status");
  await expect(status).toHaveAttribute("data-state", "waiting");
  // The single-line redesign moved the activity detail off a second row and into the
  // row's hover tooltip; the visible attention signal is the waiting badge above.
  await expect(row).toHaveAttribute("title", /Review background change/);

  const project = sidebar.locator(".group", { hasText: "pilot" });
  await project.locator(".group-toggle").click();
  await expect(project.locator(".group-attention")).toHaveAttribute(
    "data-state",
    "waiting",
  );
  await project.locator(".group-toggle").click();

  await row.click();
  await expect(
    page.getByRole("heading", { name: "Review background change" }),
  ).toBeVisible();
  await expect(
    page.getByText("Apply the queued background edit?"),
  ).toBeVisible();
});

test("a notification deep link focuses its target session", async ({
  page,
}) => {
  await page.request.get("/debug/reset");
  await page.goto("/?session=older-session");
  await expect(
    page.getByText("How does foldEvent assemble the transcript?"),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/session=/);
});

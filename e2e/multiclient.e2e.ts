import { expect, test } from "@playwright/test";

// Two browser pages = two WS clients on the same server session. Verifies the
// server-authoritative broadcast: a dialog raised for the session shows on both,
// and resolving it on one settles it on the other.
test("a dialog broadcasts to both clients and resolves on both", async ({
  context,
  page,
}) => {
  await page.request.get("/debug/reset");

  const p1 = page;
  const p2 = await context.newPage();
  await p1.goto("/?dev");
  await p2.goto("/?dev");
  await expect(p1.getByText("Routes live in")).toBeVisible();
  await expect(p2.getByText("Routes live in")).toBeVisible();

  await p1.getByRole("button", { name: "confirm", exact: true }).click();

  // both clients see the same dialog (broadcast)
  await expect(
    p1.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();
  await expect(
    p2.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();

  // answering on p1 settles it everywhere
  await p1.getByRole("dialog").getByRole("button", { name: "Allow" }).click();
  await expect(p1.getByRole("dialog")).toBeHidden();
  await expect(p2.getByRole("dialog")).toBeHidden();
  await expect(p2.getByText("Approved — continuing.")).toHaveCount(1);

  // The client that DIDN'T answer (p2) gets a "resolved elsewhere" notice instead of the
  // sheet silently vanishing; the answering client (p1) does not.
  await expect(p2.getByText("Resolved on another device")).toBeVisible();
  await expect(p1.getByText("Resolved on another device")).toHaveCount(0);

  await p2.close();
});

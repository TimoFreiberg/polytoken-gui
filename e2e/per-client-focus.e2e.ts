import { expect, test } from "@playwright/test";
import { openSidebar } from "./helpers.js";

// Per-client session focus: each browser picks which session it's viewing
// independently, so switching on one device must not switch the transcript out from
// under another. Two isolated browser contexts share one mock server (two WS
// connections = two independent focus states).
test("switching session on one client doesn't move another", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  try {
    // Fresh shared server state, then connect both clients (no stored last-session, so
    // each adopts the bootstrap landing greeting).
    await a.request.get("/debug/reset");
    await a.goto("/");
    await b.goto("/");

    // Both land on the greeting session.
    for (const page of [a, b])
      await expect(page.locator("header .title")).toContainText(
        "Wire up the WebSocket bridge",
      );

    // Client A switches to a different session.
    await openSidebar(a);
    await a
      .getByTestId("sidebar")
      .getByText("Explore the fold reducer")
      .click();
    await expect(
      a.getByText("How does foldEvent assemble the transcript?"),
    ).toBeVisible();
    await expect(a.locator("header .title")).toContainText(
      "Explore the fold reducer",
    );

    // Client B is untouched: still on the greeting, never shown A's session.
    await expect(b.locator("header .title")).toContainText(
      "Wire up the WebSocket bridge",
    );
    await expect(
      b.getByText("How does foldEvent assemble the transcript?"),
    ).toHaveCount(0);

    // And B can still drive its own focus independently afterwards.
    await b.goto("/?dev");
    await expect(b.locator("header .title")).toContainText(
      "Wire up the WebSocket bridge",
    );
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

import { expect, test } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

// Protocol v2 resume: a reconnect mid-stream must not duplicate transcript
// content — AND must actually resume. The reconnect hello carries the fold
// watermark {epoch, seq}; the server tail-replays only the missed frames. The
// recorded wire frames prove resume engaged: after the reconnect's hello there
// are live events but NO seed (a silent regression to full re-seeding — the
// exact cost resume exists to kill — fails the frame assertion below).
test("a mid-stream reconnect resumes (no re-seed) without duplicated bubbles", async ({
  page,
}) => {
  // Record server→client frame types on every socket. Must be installed BEFORE
  // navigation: routeWebSocket patches the page's WebSocket at document init,
  // so a mid-life install would silently miss the reconnect's socket.
  const frameTypes: string[] = [];
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        frameTypes.push(JSON.parse(String(message)).type as string);
      } catch {
        frameTypes.push("?");
      }
      ws.send(message as string);
    });
    ws.onMessage((message) => server.send(message as string));
  });
  await gotoFresh(page);

  await drive(page, "reply");
  // The turn is visibly under way…
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await expect(page.getByText("Good question.")).toBeVisible();

  // …cut the transport mid-stream. The mock keeps emitting server-side.
  await page.evaluate(() =>
    window.dispatchEvent(new Event("pilot:test-disconnect")),
  );
  await expect(
    page.getByText("Offline — the agent keeps running"),
  ).toBeVisible();

  // Reconnect. The hello carries {epoch, seq}; the server fills the gap.
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("Offline — the agent keeps running")).toHaveCount(
    0,
  );

  // The completed reply is present exactly once — nothing doubled by the
  // reconnect, no half-applied transcript. (The mid-turn "Good question…" text
  // collapses into the settled work block, so assert on what stays rendered:
  // the prompt row and the turn-final reply.)
  await expect(
    page.getByText("That confirms it. Making the change now"),
  ).toHaveCount(1);
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toHaveCount(1);

  // Resume engaged: a second hello was recorded (the reconnect), and nothing
  // after it is a seed — the transcript survived on the client and only the
  // gap was tail-replayed.
  const lastHello = frameTypes.lastIndexOf("hello");
  expect(lastHello).toBeGreaterThan(frameTypes.indexOf("hello"));
  expect(frameTypes.slice(lastHello)).not.toContain("seed");
});

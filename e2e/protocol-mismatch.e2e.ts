import { expect, test } from "@playwright/test";

// Protocol v2's safety net: the client hard-fails on a hello whose
// protocolVersion doesn't match its own bundled constant, instead of silently
// misfolding a newer server's stream (the stale-cached-PWA case). Simulate the
// skew by tampering the hello frame in flight; everything else is forwarded
// untouched, so this exercises the real client check end to end.
test("a protocol-version skew shows the update-required screen", async ({
  page,
}) => {
  await page.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      try {
        const parsed = JSON.parse(String(message));
        if (parsed.type === "hello") {
          parsed.protocolVersion = 0;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {
        // non-JSON frame — forward untouched
      }
      ws.send(message as string);
    });
    ws.onMessage((message) => server.send(message as string));
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Update required" }),
  ).toBeVisible();
  await expect(page.getByText(/doesn't match client/)).toBeVisible();
});

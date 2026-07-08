import { expect, test, type Page } from "@playwright/test";
import { drive, gotoFresh } from "./helpers.js";

async function gateInitialWebSocket(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    let allow = false;
    let attempts = 0;

    class BlockedSocket {
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      protocol = "";
      readyState: 0 | 1 | 2 | 3 = NativeWebSocket.CONNECTING;
      url = "ws://pantoken-blocked";

      constructor() {
        window.setTimeout(() => {
          this.readyState = NativeWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }, 0);
      }

      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
      close() {
        this.readyState = NativeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }
      send() {}
    }

    function GatedWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      attempts += 1;
      if (!allow) return new BlockedSocket() as unknown as WebSocket;
      return protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
    }

    GatedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    GatedWebSocket.OPEN = NativeWebSocket.OPEN;
    GatedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    GatedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    GatedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = GatedWebSocket as unknown as typeof WebSocket;

    Object.assign(window, {
      __pantokenAllowWebSocket: () => {
        allow = true;
      },
      __pantokenWebSocketAttempts: () => attempts,
    });
  });
}

async function gotoWithBlockedWebSocket(page: Page) {
  await page.request.get("/debug/reset");
  await gateInitialWebSocket(page);
  await page.goto("/?dev");
  const reconnect = page.getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();
  return reconnect;
}

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("a pending approval survives a reload (snapshot-on-reconnect)", async ({
  page,
}) => {
  await drive(page, "confirm");
  await expect(
    page.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();

  // reload WITHOUT resetting the server — a fresh client should catch up
  await page.reload();
  await page.goto("/?dev");

  await expect(
    page.getByRole("dialog").getByText("Run destructive command?"),
  ).toBeVisible();
});

test("transcript survives a reload", async ({ page }) => {
  await drive(page, "reply");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
  await page.goto("/?dev");
  await expect(
    page.getByText("Show me the streamed reply script."),
  ).toBeVisible();
});

test("the connection banner can reconnect immediately", async ({ page }) => {
  const reconnect = await gotoWithBlockedWebSocket(page);
  await expect(reconnect).toHaveAttribute("title", "Reconnect now (Alt+R)");
  const before = await page.evaluate(() =>
    (window as any).__pantokenWebSocketAttempts(),
  );

  await page.evaluate(() => (window as any).__pantokenAllowWebSocket());
  await reconnect.click();

  await expect(
    page.getByText("Routes live in", { exact: false }),
  ).toBeVisible();
  await expect(reconnect).toBeHidden();
  const after = await page.evaluate(() =>
    (window as any).__pantokenWebSocketAttempts(),
  );
  expect(after).toBeGreaterThan(before);
});

test("Alt+R reconnects from the connection banner", async ({ page }) => {
  const reconnect = await gotoWithBlockedWebSocket(page);
  await page.evaluate(() => (window as any).__pantokenAllowWebSocket());
  await page.keyboard.press("Alt+R");

  await expect(
    page.getByText("Routes live in", { exact: false }),
  ).toBeVisible();
  await expect(reconnect).toBeHidden();
});

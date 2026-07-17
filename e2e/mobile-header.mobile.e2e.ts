import { expect, type Locator, test } from "@playwright/test";
import { gotoFresh, openSettings, openSidebar } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

async function expectTouchSafe(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test("healthy status is silent and the session title owns the mobile header", async ({
  page,
}) => {
  const header = page.locator("header.hdr");
  await expect(header.locator(".conn")).toHaveCount(0);
  // The mock device reports a failed/blocked push subscription. This is intentionally
  // the one notification state that interrupts the quiet header, and it stays actionable.
  const notificationProblem = header.locator(".bell");
  await expect(notificationProblem).toBeVisible();
  await expect(notificationProblem).toHaveClass(/denied|error/);
  await expect(notificationProblem).toBeEnabled();
  await expect(header.locator(".sub")).toBeHidden();
  await expect(header.getByTestId("settings-toggle")).toHaveCount(0);

  const title = header.locator(".title");
  await expect(title).toHaveCSS("white-space", "nowrap");
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  await expectTouchSafe(header.getByTestId("sidebar-open"));
});

test("Settings is an icon-only sidebar button and Context lives in the header", async ({
  page,
}) => {
  await openSidebar(page);
  const settings = page.getByTestId("settings-toggle");
  await expect(settings).toBeVisible();
  // Settings is now icon-only — no "Settings" text label.
  await expect(settings).not.toContainText("Settings");
  await expectTouchSafe(settings);

  // Context is no longer in the sidebar footer; the header entry is always visible.
  await expect(page.getByTestId("sidebar-context")).toHaveCount(0);
  const contextOpen = page.getByTestId("context-open");
  await expect(contextOpen).toBeVisible();
  await expectTouchSafe(contextOpen);

  await settings.click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
});

test("a new-session draft does not expose inactive-session Context", async ({
  page,
}) => {
  await openSidebar(page);
  await page.getByTestId("sidebar-new-session").getByRole("button").click();
  await openSidebar(page);
  // The sidebar Context button is gone entirely; the header entry hides while drafting.
  await expect(page.getByTestId("sidebar-context")).toHaveCount(0);
  await expect(page.getByTestId("context-open")).toHaveCount(0);
  await expect(page.getByTestId("settings-toggle")).toBeVisible();
});

test("connection details remain available in Settings", async ({ page }) => {
  await openSettings(page, "notifications");
  const connection = page.getByTestId("connection-settings-row");
  await expect(connection).toContainText("Agent connection");
  await expect(connection).toContainText("Connected");
  await expect(connection).toContainText("Live");
});

test("a degraded connection becomes visible instead of failing silently", async ({
  page,
}) => {
  await page.request.get("/debug/reset");
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    class ClosedSocket {
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      protocol = "";
      readyState: 0 | 1 | 2 | 3 = NativeWebSocket.CONNECTING;
      url = "ws://pantoken-unavailable";
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
      }
      send() {}
    }
    Object.assign(ClosedSocket, {
      CONNECTING: NativeWebSocket.CONNECTING,
      OPEN: NativeWebSocket.OPEN,
      CLOSING: NativeWebSocket.CLOSING,
      CLOSED: NativeWebSocket.CLOSED,
    });
    window.WebSocket = ClosedSocket as unknown as typeof WebSocket;
  });
  await page.goto("/?dev");
  const status = page.locator("header.hdr .conn");
  await expect(status).toBeVisible({ timeout: 10_000 });
  await expect(status).not.toHaveClass(/connected/);
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
});

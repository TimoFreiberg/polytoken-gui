import { expect, test } from "@playwright/test";
import { drive, gotoFresh, openSidebar } from "./helpers.js";

// The dock badge is driven by a reactive $effect on store.unread in App.svelte.
// We can't see the native macOS dock badge from Playwright, but we CAN intercept
// the Tauri IPC call by injecting a __TAURI_INTERNALS__ stub via addInitScript.
// This verifies the full wiring: unread state change → $effect → setDockBadge.

test.beforeEach(async ({ page }) => {
  await gotoFresh(page);
});

test("dock badge shows unread count then clears when session is viewed", async ({
  page,
}) => {
  // Inject a __TAURI_INTERNALS__ spy before navigation. Records every invoke
  // call so we can assert the badge was set/cleared reactively.
  //
  // The stub must also answer `list_hosts`: the multi-host manager routes
  // through TauriHostProvider when __TAURI_INTERNALS__ is present (i.e. when
  // isDesktopShell() returns true). Without a valid list_hosts response,
  // provider.listHosts() crashes on `.map(undefined)` and store.start() never
  // runs — no WS connection, no sessionList, "No sessions yet." The local host
  // descriptor returned here mirrors what the native layer produces: id "local",
  // state "ready", empty label/subtitle (the client fills those from
  // store.serverLabel + "This computer"). The local host never invokes
  // connect_host — store.start() wires the compatibility singleton for it.
  await page.addInitScript(() => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    (window as unknown as { __dockBadgeCalls: typeof calls }).__dockBadgeCalls =
      calls;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args });
          if (cmd === "list_hosts") {
            return Promise.resolve([
              {
                id: "local",
                kind: "local",
                label: "",
                subtitle: "",
                state: "ready",
              },
            ]);
          }
          // list_remote_profiles is called by HostCoordinator.init() →
          // loadProfiles(). Returning [] (not undefined) prevents a TypeError
          // on .map() that would abort init() before store.start() runs.
          if (cmd === "list_remote_profiles") {
            return Promise.resolve([]);
          }
          return Promise.resolve(undefined);
        },
      },
      configurable: true,
    });
  });
  await page.goto("/?dev");

  // Drive a background session turn to completion (older-session: Running → Idle).
  // This makes it unread (store.unread gets the session id).
  await drive(page, "bgrun");

  // Wait for the background session's sidebar row to reflect "done" — proves
  // the RunCompleted event propagated through the WS → store → render path
  // (the bgrun mock emits RunCompleted at wait_ms 1500; drive() returns
  // immediately, so we must gate on the DOM, not assume synchronous delivery).
  await openSidebar(page);
  const bgRow = page
    .getByTestId("sidebar")
    .locator(".row-wrap")
    .filter({ hasText: "Explore the fold reducer" });
  await expect(bgRow.getByTestId("session-status")).toHaveAttribute(
    "data-state",
    "done",
  );

  // The $effect should have fired set_dock_badge with count: 1.
  const calls1 = await page.evaluate(
    () =>
      (window as unknown as {
        __dockBadgeCalls: { cmd: string; args?: Record<string, unknown> }[];
      }).__dockBadgeCalls,
  );
  const badgeSets = calls1.filter((c) => c.cmd === "set_dock_badge");
  expect(badgeSets.length).toBeGreaterThan(0);
  expect(badgeSets.at(-1)!.args).toEqual({ count: 1 });

  // Switch to the unread session (click its sidebar row) → it becomes read →
  // store.unread shrinks → $effect fires set_dock_badge with count: null.
  await bgRow.click();

  const calls2 = await page.evaluate(
    () =>
      (window as unknown as {
        __dockBadgeCalls: { cmd: string; args?: Record<string, unknown> }[];
      }).__dockBadgeCalls,
  );
  const badgeSets2 = calls2.filter((c) => c.cmd === "set_dock_badge");
  expect(badgeSets2.length).toBeGreaterThan(0);
  expect(badgeSets2.at(-1)!.args).toEqual({ count: null });
});

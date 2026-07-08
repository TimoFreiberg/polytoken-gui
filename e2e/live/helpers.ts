import { expect, type Page } from "@playwright/test";

// Helpers for the LIVE tier — the real PolytokenDriver over an in-process,
// corpus-backed fake daemon (PILOT_DRIVER=fake). These
// deliberately do NOT reuse e2e/helpers.ts: `gotoFresh` there waits for the mock's
// scripted greeting turn (which the fake bootstrap session has no equivalent of),
// and `drive` clicks dev-bar buttons whose labels are the MOCK's script vocabulary.
// The fake driver replays the frozen corpus, whose content differs from the mock
// fixtures — so live specs assert on structural DOM (roles / testids / presence),
// never on the mock's fixture strings.

/** Reset the fake daemon + hub to the bootstrapped default session, load the app
 *  in dev mode, and wait until the adopted session's composer is interactive. The
 *  fake bootstrap session starts with an empty transcript (just the sessionOpened
 *  snapshot), so — unlike the mock's gotoFresh — there is no greeting turn to wait
 *  for; the idle composer placeholder proves the client connected and adopted the
 *  session. */
export async function gotoFreshLive(page: Page): Promise<void> {
  await page.request.get("/debug/reset");
  await page.goto("/?dev");
  // "Message pilot…" is the idle composer placeholder; it only renders once the
  // client has connected AND adopted a (non-draft) session — the fake bootstrap
  // session's sessionOpened seed. This is the live analogue of gotoFresh's
  // work-block wait.
  await expect(page.getByPlaceholder("Message pilot…")).toBeVisible();
}

/** Drive a corpus flow by its fake-driver script name (stream / queue / abort /
 *  ask / approve). Sends the same {type:"mock", script} WS message the dev bar
 *  sends, via the ?dev-gated window hook installed in App.svelte — so there is no
 *  second script list to keep in sync with the Rust run_script match. Throws loudly
 *  if the hook is absent (wrong URL / not dev / build drift). */
export async function driveLive(page: Page, script: string): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as { __pilotMock?: (script: string) => void };
    if (!w.__pilotMock)
      throw new Error(
        "__pilotMock hook missing — is the page on /?dev and the live client built?",
      );
    w.__pilotMock(s);
  }, script);
}

// Closes the test-coverage gap flagged after the ctx.getFlag → pi.getFlag fix
// (2026-06-26): the existing session-namer-extension.test.ts asserts LOAD +
// registration (flags, source, description) but never fires the registered `input`
// handler — so the crash that prompted the fix would have stayed green. This file
// drives the same real pi `DefaultResourceLoader` (the typebox/runtime constraint
// documented in answer-extension.test.ts blocks a direct `import` of the extension
// module), grabs the registered `input` HandlerFn, and actually invokes it.
//
// What it catches that the load tests don't:
//  - the handler is actually registered for "input" (load tests check flags/tools,
//    not the event handlers Map) and is invoked without throwing on the guard paths
//    that short-circuit before pi.getSessionName() — an action method the bare loader
//    leaves as a throwing stub (createExtensionRuntime; only Runner.bindCore wires
//    real impls, which needs a live session).
//  - the guard logic: a non-interactive (no-UI) context and an extension-injected or
//    mid-stream input are both skipped before naming.
//
// What it does NOT cover (and why): the full nameSession path — pi.getFlag →
// resolveSpec → auth → stream → setSessionName — because (1) the passing-guard path
// calls pi.getSessionName() in its `if` condition, which throws under the bare loader,
// so nameSession is never reached via the loader alone; and (2) the full path needs a
// live model + auth (the typebox/runtime constraint documented in
// answer-extension.test.ts blocks a direct module import too). The ctx.getFlag →
// pi.getFlag fix specifically is now guarded by the green tsconfig.extensions.json
// typecheck (the call site typechecks; ctx has no getFlag) plus the source comment.
// Same structural gap as the other extension ports.
//
// ALSO NOT covered: the first-prompt-snapshot + bounded-retry state machine (firstPrompt /
// attempts / exhausted / inFlight) added so a failed 1st call can't re-seed the name from a
// later prompt's text, and a persistently-broken background model stops after MAX attempts.
// That logic lives in the `input` handler AFTER the guards but around the nameSession call —
// it needs a `pi` stub where getSessionName() returns controllably (empty → retry, then set
// → stop) + a mockable nameSession, neither of which the bare DefaultResourceLoader path
// provides (action methods are throwing stubs). Verified by manual state-machine trace in the
// source comment instead. A future test harness that injects a stub `pi` (bypassing the
// loader) could cover it; until then, the green extensions typecheck is the regression guard.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";

const NAMER_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/session-namer.ts",
);

function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-namer-handler-test-"));
}

async function loadNamer() {
  const agentDir = freshAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir, {
      projectTrusted: false,
    }),
    additionalExtensionPaths: [NAMER_PATH],
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  expect(errors).toEqual([]);
  const namer = extensions.find((e) => e.path === NAMER_PATH);
  expect(namer).toBeDefined();
  return namer!;
}

// A minimal stub satisfying the handler's synchronous reads. The fire-and-forget
// nameSession only touches ctx.hasUI + ctx.ui.notify on the no-flag path (it returns
// before modelRegistry/auth when the background-model flag is unset, which is the
// loader's default with no extensionFlagValues threaded). Cast through unknown so a
// partial stub typechecks against ExtensionContext without spelling out every field.
function stubCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    hasUI: true,
    ui: { notify() {} },
    ...overrides,
  } as unknown as ExtensionContext;
}

function inputEvent(over: Partial<InputEvent> = {}): InputEvent {
  return {
    type: "input",
    text: "Help me debug a flaky CI test",
    source: "interactive",
    ...over,
  };
}

// Flush the microtask queue so a fire-and-forget rejection inside nameSession settles
// and surfaces as an unhandled rejection (which Bun fails the test on). Two ticks cover
// the `.finally(() => (inFlight = false))` chained on the voided promise.
function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Grab the registered input handler with proper narrowing (noUncheckedIndexedAccess
// makes handlers[0] HandlerFn | undefined; the registration test asserts length===1).
async function getInputHandler() {
  const namer = await loadNamer();
  const handlers = namer.handlers.get("input");
  expect(handlers).toBeDefined();
  const handler = handlers?.[0];
  expect(handler).toBeDefined();
  return handler!;
}

describe("session-namer: firing the registered input handler", () => {
  test("the `input` handler is registered (one HandlerFn)", async () => {
    const namer = await loadNamer();
    const handlers = namer.handlers.get("input");
    expect(handlers).toBeDefined();
    expect(handlers?.length).toBe(1);
  });

  test("a no-UI (one-shot) context short-circuits without naming", async () => {
    // hasUI:false is the one-shot -p / json-run guard — naming has no selector to
    // benefit, so the handler must skip before kicking off nameSession. This path is
    // reachable through the bare loader (it short-circuits before pi.getSessionName(),
    // an action method the loader leaves as a throwing stub). Asserts the guard fires.
    const handler = await getInputHandler();

    const result = await handler(inputEvent(), stubCtx({ hasUI: false }));
    expect(result).toEqual({ action: "continue" });
    await flushAsync();
  });

  test("an extension-injected or mid-stream input is skipped", async () => {
    // source:"extension" (another extension's injected input) and a mid-stream steer
    // / queued followup (streamingBehavior set) are both skipped — naming only fires
    // on a real idle interactive prompt. Both short-circuit before getSessionName().
    const handler = await getInputHandler();

    const injected = await handler(
      inputEvent({ source: "extension" }),
      stubCtx(),
    );
    expect(injected).toEqual({ action: "continue" });

    const steer = await handler(
      inputEvent({ streamingBehavior: "steer" }),
      stubCtx(),
    );
    expect(steer).toEqual({ action: "continue" });
    await flushAsync();
  });
});

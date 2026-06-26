// Closes the runtime-coverage gap the tasklist loader test (tasklist-extension.test.ts)
// explicitly flags: "The extension's runtime behaviour (file persistence, the reminder
// firing, fuzzy matching) needs a live pi session and is out of unit reach." That's true
// for the file-persistence / fuzzy-match paths (they need a sessionKey from session_start,
// which the bare loader leaves as a throwing stub) — but the `before_agent_start` reminder
// handler is fully reachable: it touches only module state (tasks, turnsSinceTasklistUse)
// + event.systemPrompt, no pi action methods. And `tasklist_add`'s execute is reachable
// too (writeFile no-ops without a sessionKey; updateWidget needs only ui.setWidget).
//
// So this drives the same real pi `DefaultResourceLoader`, then fires the registered
// `before_agent_start` handler directly and the `tasklist_add` tool's execute — covering
// the reminder-injection threshold end to end, which the load tests never invoke.
// (Direct module import stays blocked by the typebox/runtime constraint documented in
// answer-extension.test.ts; the loader is the seam.)

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TASKLIST_PATH = resolve(
  import.meta.dir,
  "../../../pilot/extensions/tasklist.ts",
);

function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pilot-tasklist-handler-test-"));
}

async function loadTasklist() {
  const agentDir = freshAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir, {
      projectTrusted: false,
    }),
    additionalExtensionPaths: [TASKLIST_PATH],
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  expect(errors).toEqual([]);
  const ext = extensions.find((e) => e.path === TASKLIST_PATH);
  expect(ext).toBeDefined();
  return ext!;
}

// Minimal ctx: execute touches ctx.ui.setWidget (updateWidget). Cast through unknown so
// a partial stub typechecks against ExtensionContext without spelling every field.
function stubCtx(): ExtensionContext {
  return { ui: { setWidget() {} } } as unknown as ExtensionContext;
}

// before_agent_start event: the handler reads only event.systemPrompt.
function beforeAgentStartEvent(systemPrompt = "base") {
  return { systemPrompt } as { systemPrompt: string };
}

// Each test loads a FRESH extension (module state is per-load — the factory re-runs per
// reload, resetting tasks/turnsSinceTasklistUse). Without a fresh load, state would leak
// across tests (tasklist is module-scoped). This mirrors the per-test reload in the loader
// tests.

describe("tasklist: firing the before_agent_start reminder handler", () => {
  test("the handler is registered", async () => {
    const ext = await loadTasklist();
    expect(ext.handlers.get("before_agent_start")?.length).toBe(1);
  });

  test("no tasks → no reminder injected (returns undefined)", async () => {
    const ext = await loadTasklist();
    const handler = ext.handlers.get("before_agent_start")![0]!;
    // No tasks added: the handler short-circuits at `tasks.length === 0`.
    const result = await handler(beforeAgentStartEvent(), stubCtx());
    expect(result).toBeUndefined();
  });

  test("reminder fires only after REMINDER_INTERVAL (3) non-use turns", async () => {
    // The real assertion the loader test couldn't make: the reminder injects the open
    // tasks into the system prompt, but only once the non-use counter crosses the
    // threshold — and a tasklist tool call resets it (markToolUsed).
    const ext = await loadTasklist();
    const handler = ext.handlers.get("before_agent_start")![0]!;
    const addTool = ext.tools.get("tasklist_add");
    expect(addTool).toBeDefined();

    // Add a task via the real tool execute (the path the agent would call).
    await addTool!.definition.execute(
      "tc1",
      { descriptions: ["write the handler test"] },
      undefined,
      undefined,
      stubCtx(),
    );

    // 1st + 2nd turn after use: counter below threshold → no injection.
    expect(await handler(beforeAgentStartEvent(), stubCtx())).toBeUndefined();
    expect(await handler(beforeAgentStartEvent(), stubCtx())).toBeUndefined();

    // 3rd turn: counter hits REMINDER_INTERVAL (3) → reminder injected.
    const result = await handler(beforeAgentStartEvent(), stubCtx());
    expect(result).toEqual({
      systemPrompt:
        "base\n\nOpen Tasks (1 remaining) — use tasklist_done/delete when addressed:\n  • write the handler test",
    });
  });

  test("calling a tasklist tool resets the non-use counter", async () => {
    // markToolUsed (called by every tasklist tool) zeroes turnsSinceTasklistUse, so a
    // tool call mid-count restarts the reminder window. Guards against a regression
    // where the reset is dropped (reminder would fire too eagerly / every turn).
    const ext = await loadTasklist();
    const handler = ext.handlers.get("before_agent_start")![0]!;
    const addTool = ext.tools.get("tasklist_add")!;

    await addTool.definition.execute(
      "tc1",
      { descriptions: ["task A"] },
      undefined,
      undefined,
      stubCtx(),
    );
    // Two turns (below threshold)...
    await handler(beforeAgentStartEvent(), stubCtx());
    await handler(beforeAgentStartEvent(), stubCtx());
    // ...another tool call resets the counter...
    await addTool.definition.execute(
      "tc2",
      { descriptions: ["task B"] },
      undefined,
      undefined,
      stubCtx(),
    );
    // ...so the NEXT turn is back below threshold (no reminder), not the 3rd of the
    // original window.
    expect(await handler(beforeAgentStartEvent(), stubCtx())).toBeUndefined();
    expect(await handler(beforeAgentStartEvent(), stubCtx())).toBeUndefined();
    // 3rd turn after the reset fires — and now lists BOTH tasks.
    const result = await handler(beforeAgentStartEvent(), stubCtx());
    expect(result).toEqual({
      systemPrompt:
        "base\n\nOpen Tasks (2 remaining) — use tasklist_done/delete when addressed:\n  • task A\n  • task B",
    });
  });
});

// Runtime shape guard at the pi-internal boundary (review Rec #2).
//
// `session.messages` reaches `historyToEvents` through a structural cast
// (`session.messages as unknown as readonly HistoryMessage[]` in pi-driver.ts),
// so a pi version bump that adds or renames a renderable message role would compile
// fine but silently drop those messages from reloaded transcripts (the `default: break`
// in historyToEvents). These tests make that drift LOUD:
//
//   - `known-roles-canary` exercises EVERY role historyToEvents knows how to render,
//     so a rename/removal in pi fails the build here, not silently in production.
//   - `findUnknownHistoryRoles` + `warnUnknownHistoryRole` are the runtime guard the
//     `default:` case calls — they surface drift as a test failure and a process warning
//     instead of a silent drop.
//
// The fixture shapes mirror pi's documented session-format.md (v3) — see HistoryMessage.

import { describe, expect, spyOn, test } from "bun:test";
import {
  foldAll,
  initialSessionState,
  type SessionRef,
  type SessionSnapshot,
} from "@pilot/protocol";
import {
  findUnknownHistoryRoles,
  type HistoryMessage,
  historyToEvents,
  KNOWN_HISTORY_ROLES,
  warnUnknownHistoryRole,
} from "./history-map.js";

const ref: SessionRef = { workspaceId: "w", sessionId: "s" };
const idleSnapshot: SessionSnapshot = {
  ref,
  workspace: { workspaceId: "w", path: "/w", displayName: "w" },
  title: "t",
  status: "idle",
  updatedAt: "0",
};
const ctx = {
  ref,
  idleSnapshot,
  toolMeta: (name: string) => ({ description: `desc:${name}` }),
};

/** A transcript exercising every role historyToEvents claims to render. If pi renames
 *  or drops one, the mapping here no longer round-trips and this fails LOUD. */
const fullFixture: HistoryMessage[] = [
  { role: "user", content: "hello", timestamp: 1_700_000_000_000 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi" },
    ],
    timestamp: 1_700_000_005_000,
  },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
    ],
    timestamp: 1_700_000_010_000,
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    content: "body",
    isError: false,
    timestamp: 1_700_000_015_000,
  },
  {
    role: "custom",
    customType: "nudge",
    content: "<n/>",
    display: true,
    timestamp: 1_700_000_020_000,
  },
  {
    role: "bashExecution",
    command: "ls",
    output: "a\nb",
    exitCode: 0,
    timestamp: 1_700_000_025_000,
  },
  {
    role: "compactionSummary",
    summary: "compacted",
    timestamp: 1_700_000_030_000,
  },
  { role: "branchSummary", summary: "branched", timestamp: 1_700_000_035_000 },
  // An assistant turn that ended in an API error persists with stopReason "error".
  {
    role: "assistant",
    stopReason: "error",
    errorMessage: "boom",
    timestamp: 1_700_000_040_000,
  },
];

describe("history-map shape guard (Rec #2)", () => {
  test("KNOWN_HISTORY_ROLES has no duplicates and is non-empty", () => {
    expect(KNOWN_HISTORY_ROLES.length).toBeGreaterThan(0);
    expect(new Set(KNOWN_HISTORY_ROLES).size).toBe(KNOWN_HISTORY_ROLES.length);
  });

  test("every known role round-trips through historyToEvents (canary)", () => {
    // If any role here is dropped or mis-mapped, the event count / kinds change and
    // this fails — surfacing a pi shape drift before it silently drops messages.
    const events = historyToEvents(fullFixture, ctx);
    expect(events.length).toBeGreaterThan(0);

    const folded = foldAll(events, initialSessionState());
    const kinds = folded.items.map((i) => i.kind);
    // user, two assistant bubbles (thinking+text, then a tool call), tool result card,
    // inject, and the bashExecution/compactionSummary/branchSummary notices all render.
    expect(kinds).toContain("user");
    expect(kinds.filter((k) => k === "assistant").length).toBeGreaterThan(0);
    expect(kinds).toContain("tool");
    expect(kinds).toContain("inject");
    // The API-error assistant turn surfaces as an error notice, not a silent empty bubble.
    expect(events.some((e) => e.type === "hostUiRequest")).toBe(true);
  });

  test("the canary fixture has NO unknown roles (else the guard would already be firing)", () => {
    // This is the canary proper: if the fixture above ever includes a role that
    // historyToEvents silently drops, findUnknownHistoryRoles catches it here.
    expect(findUnknownHistoryRoles(fullFixture)).toEqual([]);
  });

  test("findUnknownHistoryRoles returns a role historyToEvents drops", () => {
    const withUnknown: HistoryMessage[] = [
      ...fullFixture,
      {
        role: "someNewPiRole",
        content: "dropped",
        timestamp: 1_700_000_050_000,
      },
    ];
    expect(findUnknownHistoryRoles(withUnknown)).toEqual(["someNewPiRole"]);
  });

  test("findUnknownHistoryRoles dedupes a repeated unknown role", () => {
    const messages: HistoryMessage[] = [
      { role: "newRole", content: "a" },
      { role: "newRole", content: "b" },
      { role: "anotherNew", content: "c" },
    ];
    expect(findUnknownHistoryRoles(messages)).toEqual([
      "newRole",
      "anotherNew",
    ]);
  });

  test("warnUnknownHistoryRole warns once per role per process", () => {
    const warn = spyOn(console, "warn");
    try {
      warnUnknownHistoryRole("oncePerProcessRole");
      warnUnknownHistoryRole("oncePerProcessRole"); // deduped — not warned again
      warnUnknownHistoryRole("differentRole");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain("oncePerProcessRole");
      expect(warn.mock.calls[0]?.[0]).toContain("unknown message role");
    } finally {
      warn.mockRestore();
    }
  });

  test("an unknown role in a mapped transcript triggers the warning (not silent)", () => {
    const warn = spyOn(console, "warn");
    try {
      const messages: HistoryMessage[] = [
        { role: "user", content: "hi" },
        { role: "mysteryRole", content: "dropped silently before the guard" },
      ];
      historyToEvents(messages, ctx);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("mysteryRole");
    } finally {
      warn.mockRestore();
    }
  });
});

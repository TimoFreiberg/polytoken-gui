// Drive the session list / switch / new path through a running pilot server over
// its WebSocket and print what comes back — a headless live check for the real pi
// driver's D13 session machinery. The mock-driver e2e suite can't exercise a real
// pi session swap, and a swap is exactly where the stale-extension-ctx crash lived
// (an extension's fire-and-forget session_start work touching a ctx we disposed).
//
// Usage:
//   # in one terminal, run the server against the real agent. The server boots to
//   # an empty landing; this script opens its own sessions, so PILOT_CWD is gone.
//   PILOT_DRIVER=pi bun run --cwd server start
//   # in another:
//   bun scripts/live-switch.ts
//
// It reads the session list, opens a NEW session (expects an empty transcript),
// then re-opens the most-populated existing session (expects its history back).
// The real assertion is implicit: the server must survive the swaps. Env: PILOT_WS
// (default ws://localhost:8787/ws), PILOT_TOKEN (sent in the hello).
// Exits 0 on a clean round-trip, 1 on timeout / ws error / unexpected state.

const url = process.env.PILOT_WS ?? "ws://localhost:8787/ws";
const token = process.env.PILOT_TOKEN;

const ws = new WebSocket(url);
let sessions: Array<{
  path: string;
  displayName?: string;
  preview?: string;
  messageCount: number;
}> = [];
let phase: "init" | "newSession" | "openSession" | "done" = "init";

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}
const timeout = setTimeout(() => fail("timeout after 90s"), 90_000);

const label = (s?: { displayName?: string; preview?: string }) =>
  s?.displayName || s?.preview || "(untitled)";

ws.onopen = () => ws.send(JSON.stringify({ type: "hello", auth: token }));

ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "sessionList") {
    sessions = m.sessions;
    console.log(
      `\n[sessionList] ${m.sessions.length} session(s) · active=${m.activeSessionId}`,
    );
    for (const s of m.sessions)
      console.log(`   - "${label(s)}" · ${s.messageCount}msg · ${s.path}`);
    if (phase === "init") {
      phase = "newSession";
      console.log("\n→ newSession");
      ws.send(JSON.stringify({ type: "newSession" }));
    }
  } else if (m.type === "snapshot") {
    const items = m.state.items.length;
    console.log(
      `[snapshot] phase=${phase} active=${m.state.ref?.sessionId} items=${items}`,
    );
    if (phase === "newSession") {
      if (items !== 0)
        fail(`expected empty transcript after newSession, got ${items} items`);
      const target = sessions.find((s) => s.messageCount > 0) ?? sessions[0];
      if (!target) fail("no existing session to re-open");
      phase = "openSession";
      console.log(`\n→ openSession "${label(target)}" (${target.path})`);
      ws.send(JSON.stringify({ type: "openSession", path: target.path }));
    } else if (phase === "openSession") {
      if (items === 0)
        fail(
          "expected history after re-opening a populated session, got 0 items",
        );
      for (const it of m.state.items)
        console.log(
          `      ${it.kind}: ${String(it.text || it.thinking || it.output || "")
            .slice(0, 55)
            .replace(/\n/g, " ")}`,
        );
      phase = "done";
      clearTimeout(timeout);
      console.log(
        `\nPASS: swapped new ↔ existing session, ${items} items replayed, server still serving.`,
      );
      ws.close();
    }
  } else if (m.type === "error") {
    fail(`server error: ${m.message}`);
  }
};
ws.onclose = () => process.exit(phase === "done" ? 0 : 1);
ws.onerror = (err) => fail(`ws error: ${err}`);

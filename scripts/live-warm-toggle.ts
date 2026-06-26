// D8 increment 2 live check: prove two distinct sessions stay warm simultaneously and
// that re-focusing one returns its full transcript instantly (the dedup/refocus path),
// not a fresh re-read from disk. Distinguishing warm-refocus from re-create is done by
// watching the server log: a refocus logs `[pi] refocus warm session …` and does NOT
// grow the warm count, whereas a cold open logs `[pi] warmed session …`.
//
// Usage (server must run the real pi driver; on-disk sessions come from ~/.pi/agent/sessions):
//   PILOT_DRIVER=pi bun run --cwd server start
//   bun scripts/live-warm-toggle.ts
//
// Sequence: open A → open B → re-open A. Asserts A's transcript is identical across the
// two opens (same item count), and that the server survives. Exits 0 on success.

const url = process.env.PILOT_WS ?? "ws://localhost:8787/ws";
const token = process.env.PILOT_TOKEN;

const ws = new WebSocket(url);
type S = {
  path: string;
  displayName?: string;
  preview?: string;
  messageCount: number;
};
let sessions: S[] = [];
let a: S | undefined;
let b: S | undefined;
let aFirstItems = -1;
let phase: "init" | "openA1" | "openB" | "openA2" | "done" = "init";

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}
const timeout = setTimeout(() => fail("timeout after 90s"), 90_000);
const label = (s?: S) =>
  s?.displayName || s?.preview?.slice(0, 40) || "(untitled)";
const open = (s: S, p: typeof phase) => {
  phase = p;
  console.log(`\n→ openSession "${label(s)}" (${p})`);
  ws.send(JSON.stringify({ type: "openSession", path: s.path }));
};

ws.onopen = () => ws.send(JSON.stringify({ type: "hello", auth: token }));

ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "sessionList") {
    sessions = m.sessions;
    if (phase !== "init") return;
    const populated = sessions.filter((s) => s.messageCount > 0);
    [a, b] = populated;
    if (!a || !b) fail(`need ≥2 populated sessions, found ${populated.length}`);
    console.log(
      `[sessionList] ${sessions.length} sessions; A="${label(a)}" B="${label(b)}"`,
    );
    open(a as S, "openA1");
  } else if (m.type === "snapshot") {
    const items = m.state.items.length;
    const active = m.state.ref?.sessionId;
    console.log(`[snapshot] phase=${phase} active=${active} items=${items}`);
    if (phase === "openA1") {
      if (items === 0) fail("A opened with empty transcript");
      aFirstItems = items;
      open(b as S, "openB");
    } else if (phase === "openB") {
      if (items === 0) fail("B opened with empty transcript");
      open(a as S, "openA2");
    } else if (phase === "openA2") {
      if (items !== aFirstItems)
        fail(
          `A's transcript changed across warm toggle: ${aFirstItems} → ${items}`,
        );
      phase = "done";
      clearTimeout(timeout);
      console.log(
        `\nPASS: A and B both warm; re-focusing A returned its ${items} items intact. ` +
          "Check the server log for a `refocus warm session` line and a steady warm count.",
      );
      ws.close();
    }
  } else if (m.type === "error") {
    fail(`server error: ${m.message}`);
  }
};
ws.onclose = () => process.exit(phase === "done" ? 0 : 1);
ws.onerror = (err) => fail(`ws error: ${err}`);

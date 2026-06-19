// Drive ONE prompt through a running pilot server over its WebSocket and stream the
// resulting events to stdout — a headless live-feedback loop for the real pi driver
// (the UI's Claude_Preview / e2e harness can't easily exercise a live model turn).
//
// The server boots to an empty landing (no session), so this opens a new session first
// and then sends the prompt. An optional second arg is the session cwd (defaults to
// $HOME); the prompt is the first arg.
//
// Usage:
//   # in one terminal, run the server against the real agent:
//   PILOT_DRIVER=pi bun run --cwd server start
//   # in another:
//   bun scripts/live-prompt.ts "list the files here and summarise the project" ~/src/some-repo
//
// Env: PILOT_WS (default ws://localhost:8787/ws), PILOT_TOKEN (sent in the hello).
// Exits 0 on runCompleted/runFailed, 1 on timeout/ws error.

const prompt = process.argv[2] ?? "Say hello in one short sentence.";
const cwd = process.argv[3]?.trim() || undefined;
const url = process.env.PILOT_WS ?? "ws://localhost:8787/ws";
const token = process.env.PILOT_TOKEN;

const ws = new WebSocket(url);
let sessionOpened = false;
let promptSent = false;
const timeout = setTimeout(() => {
  console.error("\nTIMEOUT after 120s");
  process.exit(1);
}, 120_000);

ws.onopen = () => ws.send(JSON.stringify({ type: "hello", auth: token }));

ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.type === "snapshot") {
    const hasSession = msg.state?.ref?.sessionId != null;
    // The server boots with no session — open one before prompting.
    if (!sessionOpened && !hasSession) {
      sessionOpened = true;
      console.log(`→ newSession${cwd ? ` in ${cwd}` : ""}`);
      ws.send(JSON.stringify({ type: "newSession", ...(cwd ? { cwd } : {}) }));
      return;
    }
    if (!promptSent && hasSession) {
      promptSent = true;
      console.log("→", prompt, "\n");
      ws.send(JSON.stringify({ type: "prompt", text: prompt }));
    }
  } else if (msg.type === "event") {
    const ev = msg.event;
    switch (ev.type) {
      case "userMessage":
        console.log(`[user] ${ev.text}\n`);
        break;
      case "assistantDelta":
        if (ev.channel !== "thinking") process.stdout.write(ev.text);
        break;
      case "toolStarted":
        console.log(`\n[tool:${ev.toolName}] ${JSON.stringify(ev.input)}`);
        break;
      case "toolFinished":
        console.log(`[tool done ok=${ev.success}]`);
        break;
      case "runCompleted":
        console.log("\n\n✓ runCompleted");
        clearTimeout(timeout);
        ws.close();
        break;
      case "runFailed":
        console.log("\n\n✗ runFailed:", ev.error?.message);
        clearTimeout(timeout);
        ws.close();
        break;
    }
  } else if (msg.type === "error") {
    console.error("server error:", msg.message);
    clearTimeout(timeout);
    ws.close();
  }
};

ws.onclose = () => process.exit(0);
ws.onerror = (err) => {
  console.error("ws error:", err);
  process.exit(1);
};

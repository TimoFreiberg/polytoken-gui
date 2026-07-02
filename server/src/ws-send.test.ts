import { describe, expect, mock, test } from "bun:test";
import type { ServerMessage } from "@pilot/protocol";
import { sendJson, sendOrClose, type SendableSocket } from "./ws-send.js";

/** Minimal mock implementing the SendableSocket interface. */
function mockSocket(
  opts: {
    readyState?: number;
    sendResult?: number;
  } = {},
): {
  ws: SendableSocket;
  sendSpy: ReturnType<typeof mock>;
  closeSpy: ReturnType<typeof mock>;
} {
  const sendSpy = mock(() => opts.sendResult ?? 42);
  const closeSpy = mock(() => {});
  const ws: SendableSocket = {
    readyState: opts.readyState ?? 1,
    send: sendSpy,
    close: closeSpy,
  };
  return { ws, sendSpy, closeSpy };
}

describe("sendOrClose", () => {
  test("closes the socket when send returns 0 (dropped)", () => {
    const { ws, sendSpy, closeSpy } = mockSocket({ sendResult: 0 });

    const dropped = sendOrClose(ws, "hello");

    expect(dropped).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0]).toBe("hello");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.calls[0]![0]).toBe(1011);
    expect(closeSpy.mock.calls[0]![1]).toBe("backpressure drop");
  });

  test("does not close when send returns a positive number (bytes sent)", () => {
    const { ws, sendSpy, closeSpy } = mockSocket({ sendResult: 42 });

    const dropped = sendOrClose(ws, "hello");

    expect(dropped).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  test("does not close when send returns -1 (backpressure, enqueued)", () => {
    const { ws, sendSpy, closeSpy } = mockSocket({ sendResult: -1 });

    const dropped = sendOrClose(ws, "hello");

    expect(dropped).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  test("skips send on a closing socket (readyState 2)", () => {
    const { ws, sendSpy, closeSpy } = mockSocket({
      readyState: 2,
      sendResult: 42,
    });

    const dropped = sendOrClose(ws, "hello");

    expect(dropped).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  test("skips send on a closed socket (readyState 3)", () => {
    const { ws, sendSpy, closeSpy } = mockSocket({
      readyState: 3,
      sendResult: 42,
    });

    const dropped = sendOrClose(ws, "hello");

    expect(dropped).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

describe("sendJson", () => {
  test("stringifies, sends, and invokes onDrop when the message is dropped", () => {
    const { ws, sendSpy, closeSpy } = mockSocket({ sendResult: 0 });
    const onDrop = mock(() => {});
    // A real ServerMessage fixture — an incremental stamped event to fold.
    const msg: ServerMessage = {
      type: "event",
      event: {
        type: "sessionClosed",
        sessionRef: { workspaceId: "ws-1", sessionId: "s-1" },
        timestamp: "2026-07-02T00:00:00.000Z",
        reason: "manual",
      },
      epoch: 1,
      seq: 1,
    };

    const dropped = sendJson(ws, msg, onDrop);

    expect(dropped).toBe(true);
    // The send received the JSON-stringified message.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(sent) as ServerMessage;
    expect(parsed.type).toBe("event");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // onDrop callback was invoked.
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  test("does not invoke onDrop when the message is sent successfully", () => {
    const { ws } = mockSocket({ sendResult: 42 });
    const onDrop = mock(() => {});

    const dropped = sendJson(ws, { type: "event", event: {} }, onDrop);

    expect(dropped).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  test("works without an onDrop callback (no throw)", () => {
    const { ws, closeSpy } = mockSocket({ sendResult: 0 });

    const dropped = sendJson(ws, { type: "event", event: {} });

    expect(dropped).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, test } from "bun:test";
import type { SessionDriverEvent, SessionRef } from "@pilot/protocol";
import { errorNotify, withErrorNotify } from "./config-notify.js";

const ref: SessionRef = {
  workspaceId: "/test",
  sessionId: "test-sid",
};
const ts = "2026-07-02T12:00:00.000Z";

describe("errorNotify", () => {
  test("builds a hostUiRequest notify event with level: error", () => {
    const ev = errorNotify(ref, ts, "setModel", "Failed to set model: 500");
    expect(ev).toEqual({
      type: "hostUiRequest",
      sessionRef: ref,
      timestamp: ts,
      request: {
        kind: "notify",
        requestId: "setModel-failed-2026-07-02T12-00-00-000Z",
        message: "Failed to set model: 500",
        level: "error",
      },
    });
  });

  test("requestId is namespaced by operation", () => {
    const evA = errorNotify(ref, ts, "setModel", "msg");
    const evB = errorNotify(ref, ts, "setFacet", "msg");
    expect((evA as SessionDriverEvent & { request: { requestId: string } }).request.requestId).toContain(
      "setModel",
    );
    expect((evB as SessionDriverEvent & { request: { requestId: string } }).request.requestId).toContain(
      "setFacet",
    );
  });
});

describe("withErrorNotify", () => {
  test("does not emit on success", async () => {
    const emitted: SessionDriverEvent[] = [];
    const emit = (ev: SessionDriverEvent) => emitted.push(ev);
    const now = () => ts;

    await new Promise<void>((resolve) => {
      withErrorNotify(
        Promise.resolve("ok"),
        emit,
        ref,
        now,
        "setModel",
        "Failed to set model",
        undefined,
      );
      // withErrorNotify is fire-and-forget; let the microtask queue drain.
      setTimeout(resolve, 10);
    });

    expect(emitted).toHaveLength(0);
  });

  test("emits error notify on rejection with the error message", async () => {
    const emitted: SessionDriverEvent[] = [];
    const emit = (ev: SessionDriverEvent) => emitted.push(ev);
    const now = () => ts;

    await new Promise<void>((resolve) => {
      withErrorNotify(
        Promise.reject(new Error("daemon unreachable")),
        emit,
        ref,
        now,
        "setModel",
        "Failed to set model",
        undefined,
      );
      setTimeout(resolve, 10);
    });

    expect(emitted).toHaveLength(1);
    const ev0 = emitted[0]!;
    expect(ev0.type).toBe("hostUiRequest");
    const req = (ev0 as SessionDriverEvent & { request: { kind: string; message: string; level: string } }).request;
    expect(req.kind).toBe("notify");
    expect(req.level).toBe("error");
    expect(req.message).toBe("Failed to set model: daemon unreachable");
  });

  test("handles non-Error rejections (string)", async () => {
    const emitted: SessionDriverEvent[] = [];
    const emit = (ev: SessionDriverEvent) => emitted.push(ev);
    const now = () => ts;

    await new Promise<void>((resolve) => {
      withErrorNotify(
        Promise.reject("network error"),
        emit,
        ref,
        now,
        "abort",
        "Failed to abort turn",
        undefined,
      );
      setTimeout(resolve, 10);
    });

    expect(emitted).toHaveLength(1);
    const req = (emitted[0]! as SessionDriverEvent & { request: { message: string } }).request;
    expect(req.message).toBe("Failed to abort turn: network error");
  });

  test("invokes rollback on failure", async () => {
    const emitted: SessionDriverEvent[] = [];
    const emit = (ev: SessionDriverEvent) => emitted.push(ev);
    const now = () => ts;
    let rolledBack = false;

    await new Promise<void>((resolve) => {
      withErrorNotify(
        Promise.reject(new Error("post failed")),
        emit,
        ref,
        now,
        "setPermissionMonitor",
        "Failed to set permission monitor mode",
        () => {
          rolledBack = true;
        },
      );
      setTimeout(resolve, 10);
    });

    expect(emitted).toHaveLength(1);
    expect(rolledBack).toBe(true);
  });

  test("does not invoke rollback on success", async () => {
    const emitted: SessionDriverEvent[] = [];
    const emit = (ev: SessionDriverEvent) => emitted.push(ev);
    const now = () => ts;
    let rolledBack = false;

    await new Promise<void>((resolve) => {
      withErrorNotify(
        Promise.resolve("ok"),
        emit,
        ref,
        now,
        "setPermissionMonitor",
        "Failed to set permission monitor mode",
        () => {
          rolledBack = true;
        },
      );
      setTimeout(resolve, 10);
    });

    expect(emitted).toHaveLength(0);
    expect(rolledBack).toBe(false);
  });
});

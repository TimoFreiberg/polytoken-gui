import { describe, expect, test } from "bun:test";
import {
  decideAction,
  desktopNeedsRebuild,
  hasClientsFromHealth,
  isBuildStale,
  isBusyFromHealth,
  lockfileChanged,
  originMismatch,
  parseServerPid,
  shouldNotify,
} from "./update-watcher.js";

describe("decideAction", () => {
  const act = (behind: boolean, clientsConnected: boolean, busy: boolean) =>
    decideAction({ behind, clientsConnected, busy });

  test("up to date → noop regardless of host state", () => {
    expect(act(false, false, false)).toBe("noop");
    expect(act(false, true, true)).toBe("noop");
  });
  test("behind, unattended & idle (no client, not busy) → apply", () => {
    expect(act(true, false, false)).toBe("apply");
  });
  test("behind + client connected → defer (don't restart under a viewer)", () => {
    expect(act(true, true, false)).toBe("defer");
    expect(act(true, true, true)).toBe("defer");
  });
  test("behind + background turn, no client (busy) → defer (don't abort it)", () => {
    expect(act(true, false, true)).toBe("defer");
  });
});

describe("isBuildStale", () => {
  test("built bundle matches origin/main → fresh", () => {
    expect(isBuildStale("abc123", "abc123")).toBe(false);
  });
  test("built bundle behind origin/main → stale (the manual-pull / failed-build trap)", () => {
    expect(isBuildStale("old456", "new789")).toBe(true);
  });
  test("no build stamped yet (fresh clone) → stale, so the first tick builds it", () => {
    expect(isBuildStale(null, "abc123")).toBe(true);
  });
});

describe("desktopNeedsRebuild", () => {
  test("running app's desktop sha matches origin/main → no native rebuild", () => {
    expect(desktopNeedsRebuild("tree123", "tree123")).toBe(false);
  });
  test("running app's desktop sha lags origin/main → rebuild the .app", () => {
    expect(desktopNeedsRebuild("treeOLD", "treeNEW")).toBe(true);
  });
  test("unknown app sha (older build / standalone watcher) → never relaunch", () => {
    // We refuse to blink the whole app on a comparison we can't trust; worst case is a
    // stale shell the user rebuilds by hand, not a relaunch loop.
    expect(desktopNeedsRebuild(null, "treeNEW")).toBe(false);
    expect(desktopNeedsRebuild(undefined, "treeNEW")).toBe(false);
    expect(desktopNeedsRebuild("", "treeNEW")).toBe(false);
  });
});

describe("originMismatch", () => {
  test("same origin → no mismatch", () => {
    expect(
      originMismatch(
        "http://127.0.0.1:60517/health",
        "http://127.0.0.1:60517/update/state",
      ),
    ).toBeNull();
  });
  test("different port → mismatch (the half-pinned-config bug that hid the card)", () => {
    expect(
      originMismatch(
        "http://127.0.0.1:60517/health",
        "http://127.0.0.1:8787/update/state",
      ),
    ).toBe("http://127.0.0.1:60517 vs http://127.0.0.1:8787");
  });
  test("unparseable URL → null (don't block startup on this check)", () => {
    expect(originMismatch("not a url", "also not")).toBeNull();
  });
});

describe("lockfileChanged", () => {
  test("identical content → no change", () => {
    expect(lockfileChanged("abc", "abc")).toBe(false);
  });
  test("different content → change", () => {
    expect(lockfileChanged("abc", "xyz")).toBe(true);
  });
  test("appearance / disappearance counts as a change", () => {
    expect(lockfileChanged(null, "abc")).toBe(true);
    expect(lockfileChanged("abc", null)).toBe(true);
  });
  test("both absent → no change", () => {
    expect(lockfileChanged(null, null)).toBe(false);
  });
});

describe("isBusyFromHealth", () => {
  test("explicit busy flag wins", () => {
    expect(isBusyFromHealth({ busy: true })).toBe(true);
    expect(isBusyFromHealth({ busy: false, running: 5 })).toBe(false);
  });
  test("falls back to running + initializing counts", () => {
    expect(isBusyFromHealth({ running: 1, initializing: 0 })).toBe(true);
    expect(isBusyFromHealth({ running: 0, initializing: 2 })).toBe(true);
    expect(isBusyFromHealth({ running: 0, initializing: 0 })).toBe(false);
  });
  test("no activity fields → not busy", () => {
    expect(isBusyFromHealth({ ok: true, clients: 3 })).toBe(false);
  });
  test("malformed bodies → not busy (a missing signal must not block updates)", () => {
    expect(isBusyFromHealth(null)).toBe(false);
    expect(isBusyFromHealth("nope")).toBe(false);
    expect(isBusyFromHealth(undefined)).toBe(false);
  });
});

describe("hasClientsFromHealth", () => {
  test("positive client count → connected", () => {
    expect(hasClientsFromHealth({ clients: 1 })).toBe(true);
    expect(hasClientsFromHealth({ clients: 3, busy: false })).toBe(true);
  });
  test("zero / missing / malformed → not connected", () => {
    expect(hasClientsFromHealth({ clients: 0 })).toBe(false);
    expect(hasClientsFromHealth({ ok: true })).toBe(false);
    expect(hasClientsFromHealth(null)).toBe(false);
    expect(hasClientsFromHealth("nope")).toBe(false);
  });
});

describe("shouldNotify", () => {
  test("first sighting of a target → notify", () => {
    expect(shouldNotify("sha1", null)).toBe(true);
  });
  test("same target already notified → suppress", () => {
    expect(shouldNotify("sha1", "sha1")).toBe(false);
  });
  test("origin/main moved again → re-notify", () => {
    expect(shouldNotify("sha2", "sha1")).toBe(true);
  });
  test("no target → never notify", () => {
    expect(shouldNotify(null, "sha1")).toBe(false);
    expect(shouldNotify(null, null)).toBe(false);
  });
});

describe("parseServerPid", () => {
  test("JSON record from the pidlock", () => {
    expect(parseServerPid('{"pid":4321,"serverId":"abc"}')).toBe(4321);
  });
  test("bare int from run.sh before exec", () => {
    expect(parseServerPid("12345\n")).toBe(12345);
  });
  test("garbage / empty / non-positive → null", () => {
    expect(parseServerPid("")).toBeNull();
    expect(parseServerPid("   ")).toBeNull();
    expect(parseServerPid("not-a-pid")).toBeNull();
    expect(parseServerPid('{"pid":0}')).toBeNull();
    expect(parseServerPid('{"pid":-3}')).toBeNull();
    expect(parseServerPid('{"serverId":"x"}')).toBeNull();
  });
});

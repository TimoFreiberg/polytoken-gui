// serveStatic serves the built client (client/dist). Untested — the valuable + security-
// critical part is the path-traversal defusal (normalize + leading/`..` strip) and the
// SPA fallback to index.html. A regression in the traversal guard would let
// ../../etc/passwd leak arbitrary files; a broken fallback would 404 client-side routes.
// config.clientDist is the singleton mutate-and-restore seam (same as config.token in
// config.test.ts); we point it at a tmpdir with a fake index.html + asset.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";
import { serveStatic } from "./static.js";

describe("serveStatic", () => {
  let dir: string;
  const origClientDist = config.clientDist;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pilot-static-"));
    config.clientDist = dir;
    writeFileSync(join(dir, "index.html"), "<!doctype html>spa");
    writeFileSync(join(dir, "app.js"), "console.log('app');");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    config.clientDist = origClientDist;
  });

  test("serves an existing asset by pathname", async () => {
    const res = await serveStatic("/app.js");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("console.log('app');");
  });

  test("falls back to index.html for a client-side route (SPA)", async () => {
    // A path with no matching file (a /sessions/abc route) must serve index.html so the
    // client router takes over — not a 404.
    const res = await serveStatic("/sessions/abc");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<!doctype html>spa");
  });

  test("returns null when no build is present (dev — caller returns a hint)", async () => {
    // Point at an empty dir: neither the asset nor index.html exists.
    const empty = mkdtempSync(join(tmpdir(), "pilot-static-empty-"));
    try {
      config.clientDist = empty;
      expect(await serveStatic("/anything")).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("falls back to index.html for a traversal-shaped path (no leak, no crash)", async () => {
    // serveStatic only ever sees URL pathnames (leading /). For that input shape, the
    // leading slash + normalize + join already keep the resolved path under clientDist
    // — the explicit ../ strip is defense-in-depth with no observable difference for
    // real inputs (verified: no pathname shape leaks differently with/without it). So we
    // pin the observable behavior: a traversal-shaped path neither leaks nor crashes,
    // it falls back to index.html. (If the strip were ever removed AND a caller passed a
    // non-URL relative path, this still wouldn't catch it — that gap is accepted; the
    // guard stays as belt-and-braces.)
    const res = await serveStatic("/../../etc/passwd");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<!doctype html>spa");
  });

  test("a bare root path serves index.html", async () => {
    const res = await serveStatic("/");
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("<!doctype html>spa");
  });
});

/** The delivery policy: hashed /assets/* are immutable (+404 when missing —
 *  never the SPA fallback, which would cache index.html as JavaScript after a
 *  deploy swap), revalidating files answer 304 via ETag, and compressible
 *  bodies gzip when the client accepts it. Uses one shared dist dir + unique
 *  filenames (NOT per-test dirs): the module's etag/gzip caches are keyed by
 *  dist-relative path and live for the process, matching prod's immutable-dist
 *  assumption. */
describe("serveStatic delivery policy", () => {
  let dist: string;
  const origClientDist = config.clientDist;
  const BIG_JS = `// padding\n${"x".repeat(4000)}\n`;

  beforeEach(() => {
    if (dist) return; // one shared dist for the describe (see doc comment)
    dist = mkdtempSync(join(tmpdir(), "pilot-static-policy-"));
    writeFileSync(join(dist, "index.html"), `<html>${"p".repeat(3000)}</html>`);
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "app-abc123.js"), BIG_JS);
    writeFileSync(join(dist, "assets", "tiny-def456.js"), "//t\n");
  });
  beforeEach(() => {
    config.clientDist = dist;
  });
  afterEach(() => {
    config.clientDist = origClientDist;
  });
  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  const req = (headers: Record<string, string> = {}) =>
    new Request("http://pilot.test/", { headers });

  test("hashed assets get an immutable year-long cache", async () => {
    const res = await serveStatic("/assets/app-abc123.js", req());
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("a MISSING hashed asset is a 404, never the SPA fallback", async () => {
    const res = await serveStatic("/assets/gone-999.js", req());
    expect(res?.status).toBe(404);
  });

  test("index.html revalidates: no-cache + ETag, then 304 on match", async () => {
    const first = await serveStatic("/", req());
    expect(first?.status).toBe(200);
    expect(first?.headers.get("cache-control")).toBe("no-cache");
    const tag = first?.headers.get("etag");
    expect(tag).toBeTruthy();

    const second = await serveStatic("/", req({ "if-none-match": tag! }));
    expect(second?.status).toBe(304);
    expect(await second?.text()).toBe("");
  });

  test("compressible bodies gzip when the client accepts it", async () => {
    const res = await serveStatic(
      "/assets/app-abc123.js",
      req({ "accept-encoding": "gzip, deflate, br" }),
    );
    expect(res?.headers.get("content-encoding")).toBe("gzip");
    expect(res?.headers.get("vary")).toBe("accept-encoding");
    const body = new Uint8Array(await res!.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(BIG_JS);
  });

  test("tiny files skip gzip (not worth the frame overhead)", async () => {
    const res = await serveStatic(
      "/assets/tiny-def456.js",
      req({ "accept-encoding": "gzip" }),
    );
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-encoding")).toBeNull();
  });

  test("no accept-encoding → identity body", async () => {
    const res = await serveStatic("/assets/app-abc123.js", req());
    expect(res?.headers.get("content-encoding")).toBeNull();
    expect(await res?.text()).toBe(BIG_JS);
  });
});

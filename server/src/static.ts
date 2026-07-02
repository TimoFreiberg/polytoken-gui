// Serve the built Svelte client (client/dist) so prod is a single process. In dev
// this is unused — Vite serves the client and proxies /ws + /debug here.
//
// Delivery policy (the phone-over-Tailscale reality: every uncached byte is paid
// for on a slow link, and every launch used to re-download the whole ~860KB bundle):
// - `/assets/*` carries a content hash in the filename → immutable year-long
//   cache. A missing hashed asset is a 404, NEVER the SPA fallback — serving
//   index.html as a .js response after a deploy swap is the classic
//   stale-deploy white screen.
// - Everything else (index.html, sw.js, manifest, icons) revalidates on every
//   load (`no-cache`) but answers 304 via ETag, so "revalidate" costs a header
//   round-trip, not a re-download.
// - Compressible types are gzipped once per process and cached in memory (the
//   dist is small and immutable while the server runs — updates restart it).

import { extname, join, normalize } from "node:path";
import { config } from "./config.js";

const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".webmanifest",
  ".map",
  ".txt",
]);
/** Below this, gzip's frame overhead + CPU isn't worth the bytes saved. */
const GZIP_MIN_BYTES = 1024;

// Per-process caches keyed by dist-relative path. Safe because the dist is
// immutable for the process lifetime (the desktop updater restarts the server).
const gzipCache = new Map<string, Uint8Array>();
const etagCache = new Map<string, string>();

function acceptsGzip(req: Request): boolean {
  return /(^|[,\s])gzip($|[;,])/.test(req.headers.get("accept-encoding") ?? "");
}

async function etagFor(rel: string, file: Bun.BunFile): Promise<string> {
  const cached = etagCache.get(rel);
  if (cached) return cached;
  const bytes = await file.arrayBuffer();
  const tag = `"${Bun.hash(bytes).toString(16)}-${bytes.byteLength.toString(16)}"`;
  etagCache.set(rel, tag);
  return tag;
}

async function gzipped(
  rel: string,
  file: Bun.BunFile,
): Promise<Uint8Array | null> {
  const cached = gzipCache.get(rel);
  if (cached) return cached;
  const ext = extname(rel || "index.html").toLowerCase();
  if (!COMPRESSIBLE.has(ext)) return null;
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength < GZIP_MIN_BYTES) return null;
  const gz = Bun.gzipSync(new Uint8Array(bytes));
  gzipCache.set(rel, gz);
  return gz;
}

/** Build the asset response: cache headers by class, ETag/304 for revalidating
 *  files, gzip when the client accepts it and the type is worth it. */
async function respond(
  rel: string,
  file: Bun.BunFile,
  req: Request | undefined,
): Promise<Response> {
  const immutable = rel.startsWith("assets/");
  const headers = new Headers();
  headers.set(
    "cache-control",
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );

  // Revalidation via ETag for the no-cache class (index.html, sw.js, …):
  // a match answers 304 with no body. Immutable assets skip the tag —
  // their URL changes when their content does.
  if (!immutable && req) {
    const tag = await etagFor(rel, file);
    headers.set("etag", tag);
    if (req.headers.get("if-none-match") === tag)
      return new Response(null, { status: 304, headers });
  }

  const ext = extname(rel || "index.html").toLowerCase();
  if (COMPRESSIBLE.has(ext)) headers.set("vary", "accept-encoding");
  if (req && acceptsGzip(req)) {
    const gz = await gzipped(rel, file);
    if (gz) {
      headers.set("content-encoding", "gzip");
      headers.set("content-type", file.type);
      return new Response(gz as unknown as BodyInit, { headers });
    }
  }
  return new Response(file, { headers });
}

export async function serveStatic(
  pathname: string,
  req?: Request,
): Promise<Response | null> {
  // strip leading slash + defuse path traversal
  const rel = normalize(pathname).replace(/^([/\\]|\.\.[/\\])+/, "");
  const requested = Bun.file(join(config.clientDist, rel || "index.html"));
  if (await requested.exists())
    return respond(rel || "index.html", requested, req);

  // A hashed asset that doesn't exist is a stale/mismatched deploy — 404 so the
  // browser fails loudly instead of caching index.html as JavaScript.
  if (rel.startsWith("assets/"))
    return new Response("not found", { status: 404 });

  // SPA fallback to index.html for client-side routes
  const index = Bun.file(join(config.clientDist, "index.html"));
  if (await index.exists()) return respond("index.html", index, req);

  return null; // no build present (dev) — caller returns a hint
}

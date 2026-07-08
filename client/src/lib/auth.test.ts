// captureTokenFromUrl is the pure core of getToken (the auth-token capture-then-scrub
// flow). Split out of getToken — which read location/localStorage/history globals
// inline, making the security-relevant logic untestable without a DOM — mirroring
// theme.ts's resolveThemeMode / notify.ts's shouldNotify: thread the url + a KV-like
// store in as params. The security-critical invariant: a `?token=` URL must be BOTH
// persisted AND flagged for scrubbing, so the token doesn't linger in
// history/Referer/access-logs. getToken stays as the thin wrapper doing the
// history.replaceState side-effect.

import { describe, expect, test } from "bun:test";
import { captureTokenFromUrl } from "./auth.js";

// A minimal in-memory Storage double — only getItem/setItem are used.
function kv(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
}

describe("captureTokenFromUrl (pure)", () => {
  test("a ?token= URL: persists the token + returns it + flags the URL for scrubbing", () => {
    const store = kv();
    const url = new URL("https://app.example/?token=secret123");
    const result = captureTokenFromUrl(url, store);
    expect(result.token).toBe("secret123");
    expect(result.scrubbedUrl).toBe("https://app.example/"); // token stripped
    expect(store.getItem("pantoken_token")).toBe("secret123"); // persisted
  });

  test("the scrubbed URL preserves other query params (only token is removed)", () => {
    // Scrubbing must not nuke unrelated params (e.g. a dev flag or a session id) — only
    // the token. Otherwise a one-tap auth link would clobber the rest of the URL.
    const store = kv();
    const url = new URL("https://app.example/?token=abc&dev=1&tab=settings");
    const result = captureTokenFromUrl(url, store);
    expect(result.scrubbedUrl).toBe("https://app.example/?dev=1&tab=settings");
  });

  test("a URL with no ?token= returns the persisted token + no scrub (scrubbedUrl null)", () => {
    const store = kv();
    store.setItem("pantoken_token", "already-here");
    const result = captureTokenFromUrl(new URL("https://app.example/"), store);
    expect(result.token).toBe("already-here");
    expect(result.scrubbedUrl).toBeNull(); // no scrub needed
  });

  test("no ?token= and nothing persisted → null token, no scrub", () => {
    const result = captureTokenFromUrl(new URL("https://app.example/"), kv());
    expect(result.token).toBeNull();
    expect(result.scrubbedUrl).toBeNull();
  });

  test("a ?token= with an EMPTY value is NOT captured (treated as no token)", () => {
    // `?token=` (empty) — searchParams.get returns "", which is falsy, so the capture
    // path's `if (fromUrl)` guard skips it and falls through to the stored/no-token path.
    // Pins the actual behavior: an empty token param doesn't overwrite a stored token
    // and triggers no scrub. (Arguable either way — pinning reality, not a preference.)
    const store = kv();
    store.setItem("pantoken_token", "existing");
    const result = captureTokenFromUrl(
      new URL("https://app.example/?token="),
      store,
    );
    expect(result.token).toBe("existing"); // fell through to stored
    expect(result.scrubbedUrl).toBeNull(); // no scrub
    expect(store.getItem("pantoken_token")).toBe("existing"); // not overwritten
  });

  test("a ?token= URL overwrites a previously-persisted token (re-auth via link)", () => {
    // A fresh one-tap link with a new token must replace the old stored one, not be
    // ignored because something was already persisted.
    const store = kv();
    store.setItem("pantoken_token", "old");
    const result = captureTokenFromUrl(
      new URL("https://app.example/?token=new"),
      store,
    );
    expect(result.token).toBe("new");
    expect(store.getItem("pantoken_token")).toBe("new"); // overwritten
  });
});

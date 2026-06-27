// tokenOk + tokenFromRequest are the auth gate (index.ts checks every WS upgrade +
// /debug request). Both untested — a regression (token compare inverted, Bearer parsing
// broken, falling back to ?token= when it shouldn't) would either lock everyone out or
// let everyone in. tokenOk reads config.token (the singleton) but the compare is the
// valuable part; tokenFromRequest is fully pure (takes req + url). Mutating config.token
// per-test is the natural seam since tokenOk is defined against it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config, tokenFromRequest, tokenOk } from "./config.js";

const origToken = config.token;

describe("tokenOk", () => {
  beforeEach(() => {
    config.token = origToken;
  });
  afterEach(() => {
    config.token = origToken;
  });

  test("null config token = auth disabled: any (even undefined/null) provided is OK", () => {
    config.token = null;
    expect(tokenOk(undefined)).toBe(true);
    expect(tokenOk(null)).toBe(true);
    expect(tokenOk("anything")).toBe(true);
  });

  test("set token = auth enabled: only an exact match passes", () => {
    config.token = "secret";
    expect(tokenOk("secret")).toBe(true);
    expect(tokenOk("wrong")).toBe(false);
    expect(tokenOk("")).toBe(false);
    expect(tokenOk(undefined)).toBe(false);
    expect(tokenOk(null)).toBe(false);
  });

  test("a set but empty-string token behaves like a real token (no accidental disable)", () => {
    // An empty env var would set token=""; it must NOT be treated as "auth disabled"
    // (which null means). Only null disables.
    config.token = "";
    expect(tokenOk("")).toBe(true);
    expect(tokenOk(null)).toBe(false);
    expect(tokenOk(undefined)).toBe(false);
  });
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://x/", { headers });
}

describe("tokenFromRequest", () => {
  test("prefers Authorization: Bearer <token>", () => {
    expect(
      tokenFromRequest(
        req({ authorization: "Bearer abc123" }),
        new URL("https://x/"),
      ),
    ).toBe("abc123");
  });

  test("trims whitespace around the Bearer token", () => {
    expect(
      tokenFromRequest(
        req({ authorization: "Bearer   spaced   " }),
        new URL("https://x/"),
      ),
    ).toBe("spaced");
  });

  test("ignores a non-Bearer Authorization header (no extraction, falls through)", () => {
    // A Basic auth header or a bare token must NOT be misread as a Bearer token.
    expect(
      tokenFromRequest(
        req({ authorization: "Basic dXNlcjpwYXNz" }),
        new URL("https://x/"),
      ),
    ).toBeNull();
    expect(
      tokenFromRequest(
        req({ authorization: "notabearer" }),
        new URL("https://x/"),
      ),
    ).toBeNull();
  });

  test("falls back to ?token= query param when no Bearer header", () => {
    expect(tokenFromRequest(req(), new URL("https://x/?token=fromQuery"))).toBe(
      "fromQuery",
    );
  });

  test("Bearer header wins over ?token= query param (no URL credential when a header exists)", () => {
    // The app always uses the header; the query fallback is for hand-curl only. When
    // both are present the header wins so the token stays out of URL/history/Referer.
    const r = req({ authorization: "Bearer fromHeader" });
    expect(tokenFromRequest(r, new URL("https://x/?token=fromQuery"))).toBe(
      "fromHeader",
    );
  });

  test("no header + no query param → null", () => {
    expect(tokenFromRequest(req(), new URL("https://x/"))).toBeNull();
  });
});

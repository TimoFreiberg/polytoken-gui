// Client-side auth token handling. A token can arrive via `?token=…` (handy for a
// one-tap link), which we persist to localStorage and then scrub from the URL so it
// doesn't linger in history. Sent to the server in the WS hello.

const KEY = "pantoken_token";

/** The pure core of {@link getToken}: given a URL + a KV-like store, decide the token
 *  to use AND whether the URL needs scrubbing (because it carried `?token=`). Split
 *  out (mirroring theme.ts's resolveThemeMode / notify.ts's shouldNotify) so the
 *  capture-then-scrub flow is unit-testable without the location/localStorage/history
 *  globals — the security-relevant part is that a `?token=` URL is persisted AND flagged
 *  for scrubbing so the token doesn't linger in history/Referer/logs. Returns the token
 *  (from the URL if present, else whatever's in the store) + the scrubbed URL (null when
 *  no scrub is needed). */
export function captureTokenFromUrl(
  url: URL,
  kv: Pick<Storage, "getItem" | "setItem">,
): { token: string | null; scrubbedUrl: string | null } {
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    kv.setItem(KEY, fromUrl);
    url.searchParams.delete("token");
    return { token: fromUrl, scrubbedUrl: url.toString() };
  }
  return { token: kv.getItem(KEY), scrubbedUrl: null };
}

export function getToken(): string | null {
  const result = captureTokenFromUrl(new URL(location.href), localStorage);
  if (result.scrubbedUrl) history.replaceState(null, "", result.scrubbedUrl);
  return result.token;
}

export function setToken(t: string): void {
  localStorage.setItem(KEY, t.trim());
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}

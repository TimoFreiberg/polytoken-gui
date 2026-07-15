import { describe, expect, test } from "bun:test";
import { applyCorrelatedResponse } from "./correlated-response.js";

describe("correlated remote responses", () => {
  test("a reply from an invalidated generation stays stale", () => {
    const directoryRequest = 4;
    const statRequest = 9;
    let listing = applyCorrelatedResponse<string | null>(
      directoryRequest + 1,
      null,
      directoryRequest + 1,
      "/new",
    );
    listing = applyCorrelatedResponse(
      directoryRequest + 1,
      listing.value,
      directoryRequest,
      "/old",
    );
    let stat = applyCorrelatedResponse<{
      path: string;
      exists: boolean;
    } | null>(statRequest + 1, null, statRequest + 1, {
      path: "/new",
      exists: true,
    });
    stat = applyCorrelatedResponse(statRequest + 1, stat.value, statRequest, {
      path: "/old",
      exists: false,
    });
    expect(listing).toEqual({ accepted: false, value: "/new" });
    expect(stat).toEqual({
      accepted: false,
      value: { path: "/new", exists: true },
    });
  });

  test("the newest directory and stat replies are accepted", () => {
    expect(applyCorrelatedResponse(5, "old", 5, "new")).toEqual({
      accepted: true,
      value: "new",
    });
  });
});

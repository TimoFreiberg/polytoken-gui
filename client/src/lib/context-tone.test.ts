import { describe, expect, test } from "bun:test";
import { contextTone } from "./context-tone.js";

describe("contextTone", () => {
  test("green below half", () => {
    expect(contextTone(0)).toBe("ok");
    expect(contextTone(23.6)).toBe("ok");
    expect(contextTone(49.9)).toBe("ok");
  });

  test("yellow from half to three-quarters", () => {
    expect(contextTone(50)).toBe("warning");
    expect(contextTone(74.9)).toBe("warning");
  });

  test("dark orange from three-quarters to nearly-full", () => {
    expect(contextTone(75)).toBe("accent");
    expect(contextTone(89.9)).toBe("accent");
  });

  test("red at 90% and above (incl. overflow)", () => {
    expect(contextTone(90)).toBe("danger");
    expect(contextTone(100)).toBe("danger");
    expect(contextTone(140)).toBe("danger");
  });

  test("pending count (null) draws no arc → calm band", () => {
    expect(contextTone(null)).toBe("ok");
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const manifest = join(import.meta.dir, "../../server-rs/pantoken-server/Cargo.toml");

describe("release build SHA contract", () => {
  test("server crate wires the checked-in build script", async () => {
    const text = await Bun.file(manifest).text();
    expect(text).toContain('build = "build.rs"');
    const build = await Bun.file(join(import.meta.dir, "../../server-rs/pantoken-server/build.rs")).text();
    expect(build).toContain("PANTOKEN_BUILD_SHA");
    expect(build).toContain("exactly 40 lowercase hexadecimal");
  });
});

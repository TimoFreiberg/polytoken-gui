import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapper = join(import.meta.dir, "../../deploy/run.sh");

function fixture(name: string, output: string): { home: string; version: string } {
  const home = mkdtempSync(join(tmpdir(), `pantoken-wrapper-${name}-`));
  const version = join(home, "pantoken versions", name);
  mkdirSync(join(version, "bin"), { recursive: true });
  mkdirSync(join(version, "client-dist"), { recursive: true });
  writeFileSync(join(version, "client-dist", "index.html"), `<html>${name}</html>`);
  writeFileSync(join(version, "run.sh"), Bun.file(wrapper).size ? readFileSync(wrapper) : "", { mode: 0o755 });
  chmodSync(join(version, "run.sh"), 0o755);
  writeFileSync(
    join(version, "bin", "pantoken-server"),
    `#!/bin/sh\nprintf '%s\\n' '${output}'\n`,
  );
  chmodSync(join(version, "bin", "pantoken-server"), 0o755);
  mkdirSync(join(home, ".local", "state", "pantoken"), { recursive: true });
  writeFileSync(
    join(home, ".local", "state", "pantoken", "pantoken.env"),
    "PANTOKEN_TOKEN=test-token\nPANTOKEN_VAPID_SUBJECT=mailto:test@example.com\n",
    { mode: 0o600 },
  );
  symlinkSync(version, join(home, "pantoken-live"));
  return { home, version };
}

describe("release runtime wrapper", () => {
  test("resolves the active live symlink and path with spaces", async () => {
    const f = fixture("one", "selected-one");
    const proc = Bun.spawn([join(f.home, "pantoken-live", "run.sh")], { env: { ...process.env, HOME: f.home }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stdout.trim()).toBe("selected-one");
    expect(await proc.exited, stderr).toBe(0);
  });

  test("rejects inherited data-dir override and unsafe env syntax", async () => {
    const f = fixture("unsafe", "never");
    writeFileSync(join(f.home, ".local", "state", "pantoken", "pantoken.env"), "PANTOKEN_DATA_DIR=/tmp/escape\n", { mode: 0o600 });
    const proc = Bun.spawn([wrapper], { env: { ...process.env, HOME: f.home, PANTOKEN_DATA_DIR: "/tmp/inherited" }, stderr: "pipe" });
    expect(await proc.exited).not.toBe(0);
  });
});

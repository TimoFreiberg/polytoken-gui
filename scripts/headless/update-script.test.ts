import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updater = readFileSync(join(import.meta.dir, "../../deploy/update-headless.sh"), "utf8");

describe("headless updater production contract", () => {
  test("uses the canonical release host and fixed asset names", () => {
    expect(updater).toContain('RELEASE_REPO="TimoFreiberg/polytoken-gui"');
    expect(updater).toContain('HEADLESS_ASSET="pantoken-headless-macos-aarch64.tar.gz"');
    expect(updater).toContain("releases/latest/download");
  });

  test("verifies signature and trusted validator before extraction", () => {
    expect(updater.indexOf("verify_signature()" )).toBeLessThan(updater.indexOf("validate_tar()"));
    expect(updater.indexOf("validate_tar()" )).toBeLessThan(updater.indexOf("extract_staging()"));
    expect(updater).toContain('[[ -x "$TRUSTED_VALIDATOR" ]] || die');
    expect(updater).toContain('DIGEST_RECORD="${TRUSTED_VALIDATOR}.sha256"');
  });

  test("uses atomic directory locking and exact launchctl authorization", () => {
    expect(updater).toContain('mkdir "$LOCK_DIR"');
    expect(updater).not.toContain("flock");
    expect(updater).toContain("sudo -n -l \"$_KICKSTART_CMD\"");
    expect(updater).toContain('sudo -n /bin/launchctl kickstart -k "system/${LAUNCHD_LABEL}"');
    expect(updater).not.toContain("kill $OLD");
    expect(updater).not.toContain("pkill");
  });

  test("journals rollback states and retains previous release", () => {
    for (const state of ["downloaded", "signature-verified", "archive-validated", "flipped", "restart-requested", "new-process-confirmed", "healthy", "committed", "rollback-started", "rollback-flipped", "rollback-healthy"]) {
      expect(updater).toContain(`_journal "${state}"`);
    }
    expect(updater).toContain("STAGED_OLD_DIR");
    expect(updater).toContain("prune_old_versions");
  });
});

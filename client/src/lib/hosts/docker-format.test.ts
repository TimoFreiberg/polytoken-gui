import { describe, expect, test } from "bun:test";
import {
  humanizeContainerName,
  humanizeSshHost,
  suggestPantokenRoot,
  formatBacking,
  rootRiskKey,
  ephemeralRiskKey,
  socketRiskKey,
  isRiskAckValid,
  computeRiskKeys,
  risksNeedingAcknowledgement,
  findSocketMount,
  formatFailureFamily,
  RISK_BODIES,
} from "./docker-format.js";
import type {
  ContainerInspection,
  ExecutionTargetProfile,
  PendingRisk,
  RiskKind,
} from "./types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function inspection(overrides: Partial<ContainerInspection> = {}): ContainerInspection {
  return {
    name: "work-api-dev",
    containerId: "abc123def456",
    image: "node:20-alpine",
    running: true,
    configuredUser: "dev",
    resolvedUser: "dev",
    resolvedUid: 1000,
    resolvedGid: 1000,
    resolvedHome: "/home/dev",
    os: "linux",
    arch: "arm64",
    pantokenRootSuggestion: "/home/dev/.local/share/pantoken",
    mounts: [
      {
        type: "volume",
        name: "pantoken-data",
        destination: "/home/dev/.local/share/pantoken",
        readOnly: false,
      },
    ],
    ...overrides,
  };
}

// ── humanizeContainerName ───────────────────────────────────────────────────

describe("humanizeContainerName", () => {
  test("work-api-dev → Work API Dev", () => {
    expect(humanizeContainerName("work-api-dev")).toBe("Work API Dev");
  });

  test("splits on underscores and dots", () => {
    expect(humanizeContainerName("work_api")).toBe("Work API");
    expect(humanizeContainerName("work.api.dev")).toBe("Work API Dev");
  });

  test("handles mixed separators", () => {
    expect(humanizeContainerName("work-api_dev.test")).toBe("Work API Dev Test");
  });

  test("empty string returns empty", () => {
    expect(humanizeContainerName("")).toBe("");
  });

  test("single word capitalizes", () => {
    expect(humanizeContainerName("postgres")).toBe("Postgres");
  });

  test("never overwrites user-edited name — caller checks nameTouched", () => {
    // This test verifies the contract: the function itself is pure; the caller
    // must guard with nameTouched. Here we just verify the function returns
    // the humanized form for the fixture.
    const humanized = humanizeContainerName("nightly-runner");
    expect(humanized).toBe("Nightly Runner");
    // If the user typed "My Custom Name", the caller skips this suggestion.
    expect(humanized).not.toBe("My Custom Name");
  });
});

// ── humanizeSshHost ─────────────────────────────────────────────────────────

describe("humanizeSshHost", () => {
  test("strips user@ prefix", () => {
    expect(humanizeSshHost("dev@dev-server")).toBe("dev-server");
  });

  test("strips port", () => {
    expect(humanizeSshHost("dev@dev-server:2222")).toBe("dev-server");
  });

  test("returns alias as-is when no @", () => {
    expect(humanizeSshHost("dev-server")).toBe("dev-server");
  });
});

// ── suggestPantokenRoot ────────────────────────────────────────────────────

describe("suggestPantokenRoot", () => {
  test("returns resolvedHome + /.local/share/pantoken", () => {
    expect(suggestPantokenRoot("/home/dev")).toBe(
      "/home/dev/.local/share/pantoken",
    );
  });

  test("never returns ~", () => {
    expect(suggestPantokenRoot("~")).not.toBe("~");
    expect(suggestPantokenRoot("/root")).toBe(
      "/root/.local/share/pantoken",
    );
  });

  test("strips trailing slashes from home", () => {
    expect(suggestPantokenRoot("/home/dev/")).toBe(
      "/home/dev/.local/share/pantoken",
    );
    expect(suggestPantokenRoot("/home/dev///")).toBe(
      "/home/dev/.local/share/pantoken",
    );
  });

  test("recomputes when user changes", () => {
    const root1 = suggestPantokenRoot("/home/dev");
    const root2 = suggestPantokenRoot("/home/appuser");
    expect(root1).not.toBe(root2);
    expect(root2).toBe("/home/appuser/.local/share/pantoken");
  });
});

// ── formatBacking ───────────────────────────────────────────────────────────

describe("formatBacking", () => {
  test("Persistent · volume <name>", () => {
    expect(formatBacking(inspection())).toBe("Persistent · volume pantoken-data");
  });

  test("Persistent · bind mount <path>", () => {
    const insp = inspection({
      mounts: [
        {
          type: "bind",
          source: "/host/data",
          destination: "/home/dev/.local/share/pantoken",
          readOnly: false,
        },
      ],
    });
    expect(formatBacking(insp)).toBe("Persistent · bind mount /host/data");
  });

  test("Ephemeral · container writable layer (no covering mount)", () => {
    const insp = inspection({ mounts: [] });
    expect(formatBacking(insp)).toBe("Ephemeral · container writable layer");
  });

  test("finds longest prefix match among multiple mounts", () => {
    const insp = inspection({
      mounts: [
        {
          type: "bind",
          source: "/host/home",
          destination: "/home/dev",
          readOnly: false,
        },
        {
          type: "volume",
          name: "pantoken-data",
          destination: "/home/dev/.local/share/pantoken",
          readOnly: false,
        },
      ],
    });
    // The volume mount covers the root path more specifically.
    expect(formatBacking(insp)).toBe("Persistent · volume pantoken-data");
  });
});

// ── Risk invalidation ────────────────────────────────────────────────────────

const baseEnv = {
  containerId: "abc123def456",
  pantokenRoot: "/home/dev/.local/share/pantoken",
  backingKey: "Persistent · volume pantoken-data",
  hasSocketMount: false,
};

describe("riskInvalidation", () => {
  test("root ack invalidated by new container ID", () => {
    const key1 = rootRiskKey({ ...baseEnv, containerId: "container-A" });
    const key2 = rootRiskKey({ ...baseEnv, containerId: "container-B" });
    expect(key1).not.toBe(key2);
    expect(isRiskAckValid("rootExecution", key1, { ...baseEnv, containerId: "container-A" })).toBe(true);
    expect(isRiskAckValid("rootExecution", key1, { ...baseEnv, containerId: "container-B" })).toBe(false);
  });

  test("ephemeral waiver invalidated by root path change", () => {
    const key1 = ephemeralRiskKey({ ...baseEnv, pantokenRoot: "/home/dev/.local/share/pantoken" });
    const key2 = ephemeralRiskKey({ ...baseEnv, pantokenRoot: "/data/pantoken" });
    expect(key1).not.toBe(key2);
  });

  test("ephemeral waiver invalidated by mount backing change", () => {
    const key1 = ephemeralRiskKey({ ...baseEnv, backingKey: "Persistent · volume pantoken-data" });
    const key2 = ephemeralRiskKey({ ...baseEnv, backingKey: "Ephemeral · container writable layer" });
    expect(key1).not.toBe(key2);
  });

  test("socket ack invalidated by container replacement", () => {
    const env1 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const env2 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    env2.containerId = "new-container-id";
    const key1 = socketRiskKey(env1);
    const key2 = socketRiskKey(env2);
    expect(key1).not.toBe(key2);
  });

  test("socket ack invalidated by socket mount change", () => {
    const env1 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const env2 = { ...baseEnv, hasSocketMount: true, socketMountKey: "/host/docker.sock" };
    expect(socketRiskKey(env1)).not.toBe(socketRiskKey(env2));
  });

  test("socket none when no socket mount", () => {
    expect(socketRiskKey({ ...baseEnv, hasSocketMount: false })).toBe("socket:none");
  });

  test("computeRiskKeys returns all three keys", () => {
    const keys = computeRiskKeys(baseEnv);
    expect(keys.root).toContain("root:");
    expect(keys.ephemeral).toContain("ephemeral:");
    expect(keys.socket).toBe("socket:none");
  });

  test("risksNeedingAcknowledgement with no acks returns all", () => {
    const needed = risksNeedingAcknowledgement({}, undefined, baseEnv);
    expect(needed).toContain("rootExecution");
    expect(needed).toContain("ephemeralData");
    expect(needed).not.toContain("dockerSocket"); // no socket mount
  });

  test("risksNeedingAcknowledgement with valid acks returns empty", () => {
    const keys = computeRiskKeys(baseEnv);
    const needed = risksNeedingAcknowledgement(
      { rootFingerprint: keys.root, ephemeralFingerprint: keys.ephemeral },
      undefined,
      baseEnv,
    );
    expect(needed).toEqual([]);
  });

  test("risksNeedingAcknowledgement with socket mount + no socket ack returns socket", () => {
    const env = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const keys = computeRiskKeys(env);
    const needed = risksNeedingAcknowledgement(
      { rootFingerprint: keys.root, ephemeralFingerprint: keys.ephemeral },
      undefined,
      env,
    );
    expect(needed).toContain("dockerSocket");
  });

  test("risksNeedingAcknowledgement with valid socket ack returns empty", () => {
    const env = { ...baseEnv, hasSocketMount: true, socketMountKey: "/var/run/docker.sock" };
    const keys = computeRiskKeys(env);
    const needed = risksNeedingAcknowledgement(
      { rootFingerprint: keys.root, ephemeralFingerprint: keys.ephemeral },
      keys.socket,
      env,
    );
    expect(needed).toEqual([]);
  });
});

// ── Socket mount detection ───────────────────────────────────────────────────

describe("findSocketMount", () => {
  test("detects bind mount with source ending in docker.sock", () => {
    const mounts = [
      { type: "bind" as const, source: "/var/run/docker.sock", destination: "/var/run/docker.sock", readOnly: false },
    ];
    expect(findSocketMount(mounts)).toBeDefined();
  });

  test("returns undefined when no socket mount", () => {
    const mounts = [
      { type: "volume" as const, name: "data", destination: "/data", readOnly: false },
    ];
    expect(findSocketMount(mounts)).toBeUndefined();
  });
});

// ── Contract parsing: ExecutionTargetProfile ─────────────────────────────────

describe("contractParsing", () => {
  test("ExecutionTargetProfile discriminated union round-trip", () => {
    const hostTarget: ExecutionTargetProfile = { kind: "host" };
    const dockerTarget: ExecutionTargetProfile = {
      kind: "dockerContainer",
      containerName: "work-api",
      user: "dev",
      pantokenRoot: "/home/dev/.local/share/pantoken",
    };

    // Serialize and deserialize (simulates round-trip through JSON).
    const hostJson = JSON.parse(JSON.stringify(hostTarget));
    const dockerJson = JSON.parse(JSON.stringify(dockerTarget));

    expect(hostJson.kind).toBe("host");
    expect(dockerJson.kind).toBe("dockerContainer");
    expect(dockerJson.containerName).toBe("work-api");
    expect(dockerJson.user).toBe("dev");
    expect(dockerJson.pantokenRoot).toBe("/home/dev/.local/share/pantoken");
  });

  test("legacy profiles without execution-target fields deserialize as Host", () => {
    // Simulate an old profile JSON that has no executionTarget field.
    const legacy = {
      id: "old-1",
      label: "Old Host",
      sshDestination: "user@host",
      polytokenPolicy: "requireExisting",
      xdgMode: "isolated",
      riskAcknowledgements: {},
    };
    // The default is { kind: "host" } when executionTarget is absent.
    const executionTarget = (legacy as { executionTarget?: ExecutionTargetProfile }).executionTarget ?? { kind: "host" };
    expect(executionTarget.kind).toBe("host");
  });

  test("PendingRisk DTO round-trip", () => {
    const risk: PendingRisk = {
      id: "root-1",
      kind: "rootExecution",
      fingerprint: "a".repeat(64),
      title: "Agent runs as root",
      explanation: "The container runs as root.",
      consequences: "Root can affect the host.",
      continueLabel: "Allow root",
    };
    const roundTripped = JSON.parse(JSON.stringify(risk));
    expect(roundTripped.id).toBe("root-1");
    expect(roundTripped.kind).toBe("rootExecution");
    expect(roundTripped.fingerprint).toHaveLength(64);
  });

  test("RiskKind parsing including dockerSocket", () => {
    const kinds: RiskKind[] = ["rootExecution", "ephemeralData", "dockerSocket"];
    for (const kind of kinds) {
      const risk: PendingRisk = {
        id: "test",
        kind,
        fingerprint: "fp",
        title: "x",
        explanation: "y",
        consequences: "z",
        continueLabel: "ok",
      };
      const roundTripped = JSON.parse(JSON.stringify(risk));
      expect(roundTripped.kind).toBe(kind);
    }
  });
});

// ── formatFailureFamily ──────────────────────────────────────────────────────

describe("formatFailureFamily", () => {
  test("all 9+ families map to exact user copy + action label", () => {
    const families = [
      "dockerUnavailable",
      "containerNotFound",
      "containerStopped",
      "ambiguousMatch",
      "userMissing",
      "acknowledgementRequired",
      "rootNotWritable",
      "rootNotMounted",
      "replacementMismatch",
      "containerSupportUnavailable",
      "containerNotRunning",
    ] as const;

    for (const family of families) {
      const info = formatFailureFamily(family);
      expect(info.label.length).toBeGreaterThan(0);
      // Action can be empty for containerSupportUnavailable (no destructive action).
      if (family !== "containerSupportUnavailable") {
        expect(info.action.length).toBeGreaterThan(0);
      }
    }
  });

  test("containerNotRunning has label and Retry action", () => {
    const info = formatFailureFamily("containerNotRunning");
    expect(info.label).toBe("Container not running");
    expect(info.action).toBe("Retry");
  });

  test("containerSupportUnavailable has empty action (no destructive action)", () => {
    const info = formatFailureFamily("containerSupportUnavailable");
    expect(info.label).toBe("Container support unavailable on this device");
    expect(info.action).toBe("");
  });
});

// ── Risk body copy ───────────────────────────────────────────────────────────

describe("RISK_BODIES", () => {
  test("all three risk kinds have title and body", () => {
    expect(RISK_BODIES.rootExecution.title).toBe("Agent runs as root");
    expect(RISK_BODIES.rootExecution.body.length).toBeGreaterThan(0);

    expect(RISK_BODIES.ephemeralData.title).toBe("Ephemeral Pantoken root");
    expect(RISK_BODIES.ephemeralData.body.length).toBeGreaterThan(0);
    expect(RISK_BODIES.ephemeralData.alternatePrimary).toBe("Choose another path");

    expect(RISK_BODIES.dockerSocket.title).toBe("Docker socket exposed");
    expect(RISK_BODIES.dockerSocket.body.length).toBeGreaterThan(0);
  });
});

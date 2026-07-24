import { describe, expect, test } from "bun:test";
import { validateProfileDraft, type ProfileFormDraft } from "./profile-form.js";

function baseDraft(overrides: Partial<ProfileFormDraft> = {}): ProfileFormDraft {
  return {
    label: "My server",
    sshDestination: "user@host",
    port: "",
    remoteRootOverride: "",
    serverPath: "",
    executionTarget: { kind: "host" },
    dockerContainerName: "",
    dockerUser: "",
    dockerWorkdir: "",
    dockerPantokenRoot: "",
    ...overrides,
  };
}

describe("validateProfileDraft", () => {
  test("valid draft returns null", () => {
    expect(validateProfileDraft(baseDraft())).toBeNull();
  });

  test("empty name returns error", () => {
    expect(validateProfileDraft(baseDraft({ label: "" }))).toBe("Name is required");
    expect(validateProfileDraft(baseDraft({ label: "  " }))).toBe("Name is required");
  });

  test("empty sshDestination returns error", () => {
    expect(validateProfileDraft(baseDraft({ sshDestination: "" }))).toBe("SSH destination is required");
    expect(validateProfileDraft(baseDraft({ sshDestination: "  " }))).toBe("SSH destination is required");
  });

  test("invalid port returns error", () => {
    expect(validateProfileDraft(baseDraft({ port: "0" }))).toBe("Port must be an integer between 1 and 65535");
    expect(validateProfileDraft(baseDraft({ port: "65536" }))).toBe("Port must be an integer between 1 and 65535");
    expect(validateProfileDraft(baseDraft({ port: "abc" }))).toBe("Port must be an integer between 1 and 65535");
    expect(validateProfileDraft(baseDraft({ port: "1.5" }))).toBe("Port must be an integer between 1 and 65535");
  });

  test("valid port is accepted", () => {
    expect(validateProfileDraft(baseDraft({ port: "22" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ port: "1" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ port: "65535" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ port: "" }))).toBeNull();
  });

  test("non-absolute remoteRootOverride returns error", () => {
    expect(validateProfileDraft(baseDraft({ remoteRootOverride: "relative/path" }))).toBe(
      "Remote-root override must be an absolute path (starting with /)",
    );
  });

  test("non-absolute serverPath returns error", () => {
    expect(validateProfileDraft(baseDraft({ serverPath: "relative/path" }))).toBe(
      "Server path must be an absolute path (starting with /)",
    );
  });

  test("absolute paths are accepted", () => {
    expect(validateProfileDraft(baseDraft({ remoteRootOverride: "/abs/path" }))).toBeNull();
    expect(validateProfileDraft(baseDraft({ serverPath: "/usr/local/bin/server" }))).toBeNull();
  });

  test("docker target without container name returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "", user: "root", pantokenRoot: "/root" } });
    draft.dockerContainerName = "";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "/root";
    expect(validateProfileDraft(draft)).toBe("Container name is required for Docker targets");
  });

  test("docker target without user returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "", pantokenRoot: "/root" } });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "";
    draft.dockerPantokenRoot = "/root";
    expect(validateProfileDraft(draft)).toBe("User is required for Docker targets");
  });

  test("docker target without pantokenRoot returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "" } });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "";
    expect(validateProfileDraft(draft)).toBe("Pantoken root is required for Docker targets");
  });

  test("docker target with non-absolute pantokenRoot returns error", () => {
    const draft = baseDraft({ executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "relative" } });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "relative";
    expect(validateProfileDraft(draft)).toBe("Pantoken root must be an absolute path (starting with /)");
  });

  test("docker target with non-absolute workdir returns error", () => {
    const draft = baseDraft({
      executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "/root" },
    });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "/root";
    draft.dockerWorkdir = "relative";
    expect(validateProfileDraft(draft)).toBe("Workdir must be an absolute path (starting with /)");
  });

  test("valid docker target with all fields returns null", () => {
    const draft = baseDraft({
      executionTarget: { kind: "dockerContainer", containerName: "my-container", user: "root", pantokenRoot: "/root", workdir: "/workspace" },
    });
    draft.dockerContainerName = "my-container";
    draft.dockerUser = "root";
    draft.dockerPantokenRoot = "/root";
    draft.dockerWorkdir = "/workspace";
    expect(validateProfileDraft(draft)).toBeNull();
  });
});

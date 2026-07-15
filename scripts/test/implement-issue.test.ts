import { describe, expect, test } from "bun:test";
import { extractImageUrls, imageExtension, parseDaemonOutput, parseIssueReference, plannedCommands, renderPrompt } from "../implement-issue";

describe("implement-issue helpers", () => {
  test("parses supported issue references and rejects ambiguity", () => {
    expect(parseIssueReference(["42"]).url).toBe("https://github.com/TimoFreiberg/pantoken/issues/42");
    expect(parseIssueReference(["#7"]).number).toBe(7);
    expect(parseIssueReference(["https://github.com/TimoFreiberg/pantoken/issues/9"]).number).toBe(9);
    expect(() => parseIssueReference(["1", "2"])).toThrow("Exactly one");
    expect(() => parseIssueReference(["https://example.com/issues/1"])).toThrow();
  });

  test("extracts ordered, deduplicated HTTP image references", () => {
    expect(extractImageUrls('![a](https://x.test/a.png?x=1) <img src="https://x.test/a.png?x=1"> ![b](data:image/png;base64,x) ![c](https://x.test/attachment)')).toEqual(["https://x.test/a.png?x=1", "https://x.test/attachment"]);
  });

  test("selects safe image extensions from content type or URL", () => {
    expect(imageExtension("https://github.com/user-attachments/assets/a", "image/jpeg")).toBe("jpg");
    expect(imageExtension("https://x.test/a.webp?download=1")).toBe("webp");
    expect(imageExtension("https://x.test/a", "text/html")).toBe("bin");
  });

  test("parses daemon metadata and validates ranges", () => {
    expect(parseDaemonOutput("starting session_id=abc123 port=4321")).toEqual({ sessionId: "abc123", port: 4321 });
    expect(parseDaemonOutput("ignored", { session_id: "structured", port: 65535 })).toEqual({ sessionId: "structured", port: 65535 });
    expect(() => parseDaemonOutput("session_id=x port=0")).toThrow();
    expect(() => parseDaemonOutput("port=1234")).toThrow("session_id");
  });

  test("plans workspace under <repo>/.workspaces based off main", () => {
    const cmds = plannedCommands({ number: 42, url: "x", input: "42" }, "/repo/root");
    const wsAdd = cmds[0]!;
    expect(wsAdd.slice(0, 3)).toEqual(["jj", "workspace", "add"]);
    expect(wsAdd).toContain("/repo/root/.workspaces/pantoken-issue-42");
    expect(wsAdd).toContain("--revision");
    expect(wsAdd).toContain("main");
    const polytokenNew = cmds[2]!;
    expect(polytokenNew).toContain("--config-dir");
    expect(polytokenNew).toContain("/repo/root/scripts/polytoken-config");
    expect(polytokenNew).toContain("new");
    expect(polytokenNew).toContain("--no-attach");
    const zellij = cmds[3]!;
    expect(zellij).not.toContain("--block-until-exit");
  });

  test("renders hostile multiline issue data without shell interpolation", () => {
    const issue = { number: 4, input: "4", url: "https://github.com/TimoFreiberg/pantoken/issues/4", title: "quotes ' \" \\", body: "line 1\n{{ISSUE_TITLE}}\n日本語" };
    expect(renderPrompt("{{ISSUE_TITLE}}\n{{ISSUE_BODY}}\n{{ISSUE_IMAGES}}", issue, [], false)).toContain(issue.body);
  });
});

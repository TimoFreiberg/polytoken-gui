import { describe, expect, test } from "bun:test";
import type { CommandInfo, McpServerInfo } from "@pantoken/protocol";
import {
  filterCommands,
  filterMcpActions,
  filterMcpServers,
  filterFacets,
  filterGoalSubcommands,
  facetArgStage,
  goalArgStage,
  mcpArgStage,
  parseSlashCommand,
  slashQuery,
} from "./slash.js";

const CMDS: CommandInfo[] = [
  { name: "review", source: "prompt", argumentHint: "[path]" },
  { name: "plan", source: "prompt" },
  { name: "pr", source: "extension" },
  { name: "core-review", source: "extension" },
  { name: "skill:debug", source: "skill" },
];

describe("slashQuery", () => {
  test("returns the text after a leading slash with no whitespace", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/skill:de")).toBe("skill:de");
  });

  test("is inactive once the name is settled or the draft isn't a slash token", () => {
    expect(slashQuery("/review src")).toBeNull(); // space → typing args now
    expect(slashQuery("/review\n")).toBeNull(); // newline counts as whitespace
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("")).toBeNull();
    expect(slashQuery(" /review")).toBeNull(); // leading space, not a command
  });
});

describe("filterCommands", () => {
  test("empty query returns every command, alphabetical", () => {
    expect(filterCommands(CMDS, "").map((c) => c.name)).toEqual([
      "core-review",
      "plan",
      "pr",
      "review",
      "skill:debug",
    ]);
  });

  test("prefix matches rank above interior matches", () => {
    // "review" (prefix) before "core-review" (interior)
    expect(filterCommands(CMDS, "review").map((c) => c.name)).toEqual([
      "review",
      "core-review",
    ]);
  });

  test("is case-insensitive and matches interior substrings", () => {
    expect(filterCommands(CMDS, "DEBUG").map((c) => c.name)).toEqual([
      "skill:debug",
    ]);
  });

  test("prefix group is sorted alphabetically among ties", () => {
    // "p" prefixes: "plan", "pr" → alphabetical
    expect(filterCommands(CMDS, "p").map((c) => c.name)).toEqual([
      "plan",
      "pr",
    ]);
  });

  test("no match yields an empty list", () => {
    expect(filterCommands(CMDS, "zzz")).toEqual([]);
  });
});

describe("parseSlashCommand", () => {
  test("extracts a bare command name with no args", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
  });

  test("extracts a command name and args", () => {
    expect(parseSlashCommand("/compact summary text")).toEqual({
      name: "compact",
      args: "summary text",
    });
  });

  test("extracts a namespaced command name", () => {
    expect(parseSlashCommand("/skill:debug")).toEqual({
      name: "skill:debug",
      args: "",
    });
  });

  test("extracts args that look like file paths", () => {
    expect(parseSlashCommand("/review src/foo.ts")).toEqual({
      name: "review",
      args: "src/foo.ts",
    });
  });

  test("returns null for non-slash text", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });

  test("trims leading whitespace before checking for a slash", () => {
    expect(parseSlashCommand("  /clear")).toEqual({
      name: "clear",
      args: "",
    });
  });

  test("returns null for a bare slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });

  test("returns null when a space immediately follows the slash", () => {
    expect(parseSlashCommand("/ foo")).toBeNull();
  });
});

const SERVERS: McpServerInfo[] = [
  { serverName: "filesystem", status: "connected", toolCount: 11 },
  { serverName: "github", status: "disconnected", toolCount: 0 },
];

describe("mcpArgStage", () => {
  test("null when the name is still being typed (no space)", () => {
    expect(mcpArgStage("/mcp")).toBeNull();
    expect(mcpArgStage("/mc")).toBeNull();
    expect(mcpArgStage("/mcpx ")).toBeNull(); // /mcpx is not /mcp
  });

  test("null for unrelated drafts", () => {
    expect(mcpArgStage("hello")).toBeNull();
    expect(mcpArgStage("/clear")).toBeNull();
    expect(mcpArgStage("")).toBeNull();
    expect(mcpArgStage("/review src")).toBeNull();
  });

  test("server stage with an empty partial right after the space", () => {
    expect(mcpArgStage("/mcp ")).toEqual({ stage: "server", partial: "", serverName: "" });
  });

  test("server stage with a partial being typed", () => {
    expect(mcpArgStage("/mcp play")).toEqual({ stage: "server", partial: "play", serverName: "" });
    expect(mcpArgStage("/mcp file")).toEqual({ stage: "server", partial: "file", serverName: "" });
  });

  test("action stage with an empty partial right after the second space", () => {
    expect(mcpArgStage("/mcp playwright ")).toEqual({
      stage: "action",
      partial: "",
      serverName: "playwright",
    });
  });

  test("action stage with a partial being typed", () => {
    expect(mcpArgStage("/mcp playwright en")).toEqual({
      stage: "action",
      partial: "en",
      serverName: "playwright",
    });
  });

  test("serverName carries through to the action stage", () => {
    expect(mcpArgStage("/mcp filesystem dis")?.serverName).toBe("filesystem");
  });

  test("collapses consecutive whitespace into a single separator", () => {
    expect(mcpArgStage("/mcp  filesystem")).toEqual({
      stage: "server",
      partial: "filesystem",
      serverName: "",
    });
    expect(mcpArgStage("/mcp  filesystem  ")).toEqual({
      stage: "action",
      partial: "",
      serverName: "filesystem",
    });
  });

  test("past the action stage (3+ tokens) returns null", () => {
    expect(mcpArgStage("/mcp filesystem disable extra")).toBeNull();
  });

  test("is case-insensitive on the command name", () => {
    expect(mcpArgStage("/MCP filesystem ")).toEqual({
      stage: "action",
      partial: "",
      serverName: "filesystem",
    });
    expect(mcpArgStage("/Mcp play")).toEqual({ stage: "server", partial: "play", serverName: "" });
  });

  test("is cursor-aware: mid-token cursor returns the partial up to the cursor", () => {
    // draft "/mcp filesystem dis|able" with cursor before "able"
    expect(mcpArgStage("/mcp filesystem disable", "/mcp filesystem dis".length)).toEqual({
      stage: "action",
      partial: "dis",
      serverName: "filesystem",
    });
  });

  test("is cursor-aware: cursor before the separator is null (slash menu owns it)", () => {
    expect(mcpArgStage("/mcp filesystem disable", "/mcp".length)).toBeNull();
  });
});

describe("filterMcpServers", () => {
  test("empty query returns every server", () => {
    expect(filterMcpServers(SERVERS, "").map((s) => s.serverName)).toEqual([
      "filesystem",
      "github",
    ]);
  });

  test("substring filter narrows the list", () => {
    expect(filterMcpServers(SERVERS, "file").map((s) => s.serverName)).toEqual([
      "filesystem",
    ]);
  });

  test("no match yields an empty list", () => {
    expect(filterMcpServers(SERVERS, "zzz")).toEqual([]);
  });

  test("prefix matches rank above interior matches", () => {
    const mixed: McpServerInfo[] = [
      { serverName: "myserver", status: "connected", toolCount: 0 },
      { serverName: "server-x", status: "connected", toolCount: 0 },
    ];
    // "server-x" is a prefix match (at===0); "myserver" is interior (at===2).
    expect(filterMcpServers(mixed, "server").map((s) => s.serverName)).toEqual([
      "server-x",
      "myserver",
    ]);
  });
});

describe("filterMcpActions", () => {
  test("empty query returns all four actions (alphabetical)", () => {
    // All are prefix matches (at===0), so ties break alphabetically.
    expect(filterMcpActions("").map((a) => a.action)).toEqual([
      "disable",
      "disconnect",
      "enable",
      "reconnect",
    ]);
  });

  test("prefix filter narrows", () => {
    expect(filterMcpActions("dis").map((a) => a.action)).toEqual([
      "disable",
      "disconnect",
    ]);
  });

  test("reconnect is matched by 're'", () => {
    expect(filterMcpActions("re").map((a) => a.action)).toEqual(["reconnect"]);
  });

  test("no match yields an empty list", () => {
    expect(filterMcpActions("zzz")).toEqual([]);
  });
});

describe("facetArgStage", () => {
  test("null when the name is still being typed (no space)", () => {
    expect(facetArgStage("/facet")).toBeNull();
    expect(facetArgStage("/fac")).toBeNull();
    expect(facetArgStage("/facetx ")).toBeNull(); // /facetx is not /facet
  });

  test("null for unrelated drafts", () => {
    expect(facetArgStage("hello")).toBeNull();
    expect(facetArgStage("/clear")).toBeNull();
    expect(facetArgStage("")).toBeNull();
    expect(facetArgStage("/review src")).toBeNull();
  });

  test("facet stage with an empty partial right after the space", () => {
    expect(facetArgStage("/facet ")).toEqual({ partial: "" });
  });

  test("facet stage with a partial being typed", () => {
    expect(facetArgStage("/facet pl")).toEqual({ partial: "pl" });
    expect(facetArgStage("/facet exe")).toEqual({ partial: "exe" });
  });

  test("collapses consecutive whitespace into a single separator", () => {
    expect(facetArgStage("/facet  plan")).toEqual({ partial: "plan" });
  });

  test("past the single arg stage (2+ tokens) returns null", () => {
    expect(facetArgStage("/facet plan extra")).toBeNull();
  });

  test("is case-insensitive on the command name", () => {
    expect(facetArgStage("/FACET pl")).toEqual({ partial: "pl" });
    expect(facetArgStage("/Facet ")).toEqual({ partial: "" });
  });

  test("is cursor-aware: mid-token cursor returns the partial up to the cursor", () => {
    // draft "/facet pla|n" with cursor before "n"
    expect(facetArgStage("/facet plan", "/facet pla".length)).toEqual({ partial: "pla" });
  });

  test("is cursor-aware: cursor before the separator is null (slash menu owns it)", () => {
    expect(facetArgStage("/facet plan", "/facet".length)).toBeNull();
  });
});

describe("goalArgStage", () => {
  test("null when the name is still being typed (no space)", () => {
    expect(goalArgStage("/goal")).toBeNull();
    expect(goalArgStage("/go")).toBeNull();
    expect(goalArgStage("/goalx ")).toBeNull(); // /goalx is not /goal
  });

  test("null for unrelated drafts", () => {
    expect(goalArgStage("hello")).toBeNull();
    expect(goalArgStage("/clear")).toBeNull();
    expect(goalArgStage("")).toBeNull();
    expect(goalArgStage("/review src")).toBeNull();
  });

  test("subcommand stage with an empty partial right after the space", () => {
    expect(goalArgStage("/goal ")).toEqual({ partial: "", subcommand: null });
  });

  test("subcommand stage with a partial being typed", () => {
    expect(goalArgStage("/goal se")).toEqual({ partial: "se", subcommand: null });
    expect(goalArgStage("/goal cl")).toEqual({ partial: "cl", subcommand: null });
  });

  test("settled subcommand 'set' with empty partial (show hint)", () => {
    expect(goalArgStage("/goal set ")).toEqual({ partial: "", subcommand: "set" });
  });

  test("settled subcommand 'set' with text being typed (show hint)", () => {
    expect(goalArgStage("/goal set hello")).toEqual({ partial: "hello", subcommand: "set" });
  });

  test("settled subcommand 'pause' with empty partial (no menu, no hint)", () => {
    expect(goalArgStage("/goal pause ")).toEqual({ partial: "", subcommand: "pause" });
  });

  test("settled subcommand 'clear' with empty partial (no menu, no hint)", () => {
    expect(goalArgStage("/goal clear ")).toEqual({ partial: "", subcommand: "clear" });
  });

  test("settled subcommand 'resume' with empty partial (no menu, no hint)", () => {
    expect(goalArgStage("/goal resume ")).toEqual({ partial: "", subcommand: "resume" });
  });

  test("bogus subcommand settles (no menu, no hint — Enter dispatches to error)", () => {
    expect(goalArgStage("/goal bogus ")).toEqual({ partial: "", subcommand: "bogus" });
  });

  test("multi-word text after a settled subcommand stays in hint/text mode", () => {
    // The parser is purely structural — it can't distinguish `set` (takes
    // multi-word text) from `pause` (no args). So 2+ tokens never return null;
    // the last token is always the partial, the first is the subcommand.
    expect(goalArgStage("/goal pause extra")).toEqual({ partial: "extra", subcommand: "pause" });
    expect(goalArgStage("/goal set hello world")).toEqual({ partial: "world", subcommand: "set" });
  });

  test("collapses consecutive whitespace into a single separator", () => {
    expect(goalArgStage("/goal  set")).toEqual({ partial: "set", subcommand: null });
    expect(goalArgStage("/goal  set ")).toEqual({ partial: "", subcommand: "set" });
  });

  test("is case-insensitive on the command name", () => {
    expect(goalArgStage("/GOAL set ")).toEqual({ partial: "", subcommand: "set" });
    expect(goalArgStage("/Goal se")).toEqual({ partial: "se", subcommand: null });
  });

  test("is cursor-aware: mid-token cursor returns the partial up to the cursor", () => {
    // draft "/goal se|t" with cursor before "t"
    expect(goalArgStage("/goal set", "/goal se".length)).toEqual({ partial: "se", subcommand: null });
  });

  test("is cursor-aware: cursor before the separator is null (slash menu owns it)", () => {
    expect(goalArgStage("/goal set", "/goal".length)).toBeNull();
  });
});

describe("filterFacets", () => {
  const FACETS = ["execute", "plan", "research"];

  test("empty query returns all facets in original order", () => {
    expect(filterFacets(FACETS, "")).toEqual(["execute", "plan", "research"]);
  });

  test("substring filter narrows the list", () => {
    expect(filterFacets(FACETS, "pl")).toEqual(["plan"]);
  });

  test("no match yields an empty list", () => {
    expect(filterFacets(FACETS, "zzz")).toEqual([]);
  });

  test("prefix matches rank above interior matches", () => {
    const mixed = ["myplan", "plan-x"];
    // "plan-x" is a prefix match (at===0); "myplan" is interior (at===2).
    expect(filterFacets(mixed, "plan")).toEqual(["plan-x", "myplan"]);
  });
});

describe("filterGoalSubcommands", () => {
  test("empty query returns all four, alphabetical (all are prefix matches)", () => {
    // filterNames sorts by (prefix-group, then localeCompare). All four match
    // at===0 (empty query is a prefix of every name), so they sort alphabetically.
    expect(filterGoalSubcommands("").map((s) => s.name)).toEqual([
      "clear",
      "pause",
      "resume",
      "set",
    ]);
  });

  test("'se' matches set (prefix) and pause (interior at index 3)", () => {
    // "set": "se" at index 0 (prefix); "pause": "se" at index 3 (interior).
    expect(filterGoalSubcommands("se").map((s) => s.name)).toEqual(["set", "pause"]);
  });

  test("'cl' matches clear only", () => {
    expect(filterGoalSubcommands("cl").map((s) => s.name)).toEqual(["clear"]);
  });

  test("'re' matches resume (prefix) only", () => {
    // "resume": "re" at index 0; "clear" does not contain "re".
    expect(filterGoalSubcommands("re").map((s) => s.name)).toEqual(["resume"]);
  });

  test("no match yields an empty list", () => {
    expect(filterGoalSubcommands("zzz")).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { toolPreview, webSearchResultTitle } from "./tool-preview.js";

// ── toolPreview: per-tool field selection ────────────────────────────────────

describe("toolPreview", () => {
  // Empty-preview tools: the span renders but carries no text.
  test("write_plan returns empty string", () => {
    expect(toolPreview("write_plan", { content: "# Goal" }, undefined)).toBe(
      "",
    );
  });

  test("edit_plan returns empty string", () => {
    expect(
      toolPreview("edit_plan", { old_string: "a", new_string: "b" }, undefined),
    ).toBe("");
  });

  test("handoff_plan returns empty string", () => {
    expect(toolPreview("handoff_plan", { facet: "execute" }, undefined)).toBe(
      "",
    );
  });

  test("popd returns empty string", () => {
    expect(toolPreview("popd", {}, undefined)).toBe("");
  });

  // todo tools
  test("todo_create shows only title", () => {
    expect(
      toolPreview(
        "todo_create",
        { title: "Fix the bug", description: "..." },
        undefined,
      ),
    ).toBe("Fix the bug");
  });

  test("todo_list shows only status_filter", () => {
    expect(
      toolPreview("todo_list", { status_filter: "pending" }, undefined),
    ).toBe("pending");
  });

  test("todo_list with null status_filter returns empty", () => {
    expect(toolPreview("todo_list", { status_filter: null }, undefined)).toBe(
      "",
    );
  });

  test("todo_update shows id and title space-joined", () => {
    expect(
      toolPreview("todo_update", { id: 2, title: "Updated title" }, undefined),
    ).toBe("2 Updated title");
  });

  test("todo_update with missing title shows just id", () => {
    expect(toolPreview("todo_update", { id: 5 }, undefined)).toBe("5");
  });

  test("todo_complete shows only id", () => {
    expect(toolPreview("todo_complete", { id: 1 }, undefined)).toBe("1");
  });

  // subagent
  test("subagent shows name, subagent_type, and model_override", () => {
    expect(
      toolPreview(
        "subagent",
        {
          name: "rev",
          subagent_type: "general-purpose",
          model_override: "codex/gpt-5",
        },
        undefined,
      ),
    ).toBe("rev general-purpose codex/gpt-5");
  });

  test("subagent with null model_override omits it", () => {
    expect(
      toolPreview(
        "subagent",
        { name: "rev", subagent_type: "general-purpose", model_override: null },
        undefined,
      ),
    ).toBe("rev general-purpose");
  });

  test("subagent with missing model_override omits it", () => {
    expect(
      toolPreview(
        "subagent",
        { name: "rev", subagent_type: "general-purpose" },
        undefined,
      ),
    ).toBe("rev general-purpose");
  });

  // skill
  test("skill shows only name", () => {
    expect(toolPreview("skill", { name: "debug" }, undefined)).toBe("debug");
  });

  // job tools
  test("job_status shows only job_id", () => {
    expect(
      toolPreview(
        "job_status",
        { job_id: "general-purpose:example" },
        undefined,
      ),
    ).toBe("general-purpose:example");
  });

  test("job_block shows only job_id", () => {
    expect(
      toolPreview(
        "job_block",
        {
          job_id: "general-purpose:example",
          wait_seconds: 60,
          timeout_seconds: 90,
        },
        undefined,
      ),
    ).toBe("general-purpose:example");
  });

  // propose_goal
  test("propose_goal shows only summary", () => {
    expect(
      toolPreview("propose_goal", { summary: "Finish the feature" }, undefined),
    ).toBe("Finish the feature");
  });

  // block_goal
  test("block_goal shows terminal_reason as plain string", () => {
    expect(
      toolPreview(
        "block_goal",
        { terminal_reason: "Waiting on missing credentials" },
        undefined,
      ),
    ).toBe("Waiting on missing credentials");
  });

  test("block_goal with struct terminal_reason prefers detail", () => {
    expect(
      toolPreview(
        "block_goal",
        {
          terminal_reason: { kind: "blocked", detail: "No credentials found" },
        },
        undefined,
      ),
    ).toBe("No credentials found");
  });

  test("block_goal with struct terminal_reason falls back to kind", () => {
    expect(
      toolPreview(
        "block_goal",
        { terminal_reason: { kind: "blocked" } },
        undefined,
      ),
    ).toBe("blocked");
  });

  // web_search (input fallback when no output)
  test("web_search with no output falls back to query", () => {
    expect(
      toolPreview("web_search", { query: "weather munich" }, undefined),
    ).toBe("weather munich");
  });

  test("web_search with null output falls back to query", () => {
    expect(toolPreview("web_search", { query: "weather munich" }, null)).toBe(
      "weather munich",
    );
  });

  test("web_search with no output and no query returns empty", () => {
    expect(toolPreview("web_search", {}, undefined)).toBe("");
  });

  // web_search with output (title extraction)
  test("web_search with plain-string output shows first title", () => {
    const output = JSON.stringify([
      { title: "Weather in Munich", url: "https://example.com/1" },
      { title: "Munich Forecast", url: "https://example.com/2" },
    ]);
    expect(toolPreview("web_search", { query: "weather munich" }, output)).toBe(
      "Weather in Munich, …",
    );
  });

  test("web_search with plain-string output and single result shows title without ellipsis", () => {
    const output = JSON.stringify([
      { title: "Only result", url: "https://example.com" },
    ]);
    expect(toolPreview("web_search", { query: "test" }, output)).toBe(
      "Only result",
    );
  });

  test("web_search with raw array output shows first title", () => {
    expect(
      toolPreview("web_search", { query: "weather munich" }, [
        { title: "Weather in Munich", url: "https://example.com/1" },
        { title: "Munich Forecast", url: "https://example.com/2" },
      ]),
    ).toBe("Weather in Munich, …");
  });

  test("web_search with content-wrapped output shows first title", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { title: "Weather in Munich", url: "https://example.com/1" },
            { title: "Munich Forecast", url: "https://example.com/2" },
          ]),
        },
      ],
    };
    expect(toolPreview("web_search", { query: "weather munich" }, output)).toBe(
      "Weather in Munich, …",
    );
  });

  test("web_search with malformed string output falls back to query", () => {
    expect(
      toolPreview("web_search", { query: "weather munich" }, "not json at all"),
    ).toBe("weather munich");
  });

  test("web_search with empty array output falls back to query", () => {
    expect(toolPreview("web_search", { query: "weather munich" }, "[]")).toBe(
      "weather munich",
    );
  });

  test("web_search with output but missing query returns title", () => {
    const output = JSON.stringify([
      { title: "Some title", url: "https://example.com" },
    ]);
    expect(toolPreview("web_search", {}, output)).toBe("Some title");
  });

  // null input handling
  test("null input with non-web_search tool returns empty", () => {
    expect(toolPreview("bash", null, undefined)).toBe("");
  });

  test("web_search with null input and output shows title", () => {
    const output = JSON.stringify([
      { title: "Weather in Munich", url: "https://example.com/1" },
    ]);
    expect(toolPreview("web_search", null, output)).toBe("Weather in Munich");
  });

  // Default fallback (unknown tools)
  test("unknown tool with command falls back to default behavior", () => {
    expect(toolPreview("bash", { command: "ls -la" }, undefined)).toBe(
      "ls -la",
    );
  });

  test("unknown tool with path falls back to default behavior", () => {
    expect(toolPreview("read", { path: "src/main.ts" }, undefined)).toBe(
      "src/main.ts",
    );
  });

  test("unknown tool with file_path falls back to default behavior", () => {
    expect(
      toolPreview("file_edit", { file_path: "src/main.rs" }, undefined),
    ).toBe("src/main.rs");
  });

  test("unknown tool with only unrelated fields falls back to stringify", () => {
    expect(toolPreview("some_tool", { foo: "bar", baz: 42 }, undefined)).toBe(
      '{"foo":"bar","baz":42}',
    );
  });

  test("unknown tool with null input returns empty", () => {
    expect(toolPreview("some_tool", null, undefined)).toBe("");
  });

  // Bounding
  test("long title is truncated with ellipsis", () => {
    const longTitle = "x".repeat(400);
    expect(toolPreview("todo_create", { title: longTitle }, undefined)).toBe(
      `${"x".repeat(320)}…`,
    );
  });
});

// ── webSearchResultTitle: output shape parsing ───────────────────────────────

describe("webSearchResultTitle", () => {
  test("plain string with JSON array returns first title + ellipsis", () => {
    const output = JSON.stringify([
      { title: "First", url: "https://a.com" },
      { title: "Second", url: "https://b.com" },
    ]);
    expect(webSearchResultTitle(output)).toBe("First, …");
  });

  test("plain string with single result returns title without ellipsis", () => {
    const output = JSON.stringify([{ title: "Only", url: "https://a.com" }]);
    expect(webSearchResultTitle(output)).toBe("Only");
  });

  test("raw array returns first title + ellipsis", () => {
    expect(
      webSearchResultTitle([
        { title: "First", url: "https://a.com" },
        { title: "Second", url: "https://b.com" },
      ]),
    ).toBe("First, …");
  });

  test("content-wrapped object returns first title + ellipsis", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { title: "First", url: "https://a.com" },
            { title: "Second", url: "https://b.com" },
          ]),
        },
      ],
    };
    expect(webSearchResultTitle(output)).toBe("First, …");
  });

  test("malformed string returns null", () => {
    expect(webSearchResultTitle("not json")).toBeNull();
  });

  test("empty array string returns null", () => {
    expect(webSearchResultTitle("[]")).toBeNull();
  });

  test("non-array JSON string returns null", () => {
    expect(webSearchResultTitle('{"foo":"bar"}')).toBeNull();
  });

  test("null returns null", () => {
    expect(webSearchResultTitle(null)).toBeNull();
  });

  test("undefined returns null", () => {
    expect(webSearchResultTitle(undefined)).toBeNull();
  });

  test("number returns null", () => {
    expect(webSearchResultTitle(42)).toBeNull();
  });

  test("array with non-object first element returns null", () => {
    expect(webSearchResultTitle(["string", { title: "Second" }])).toBeNull();
  });

  test("array element without title returns null", () => {
    expect(webSearchResultTitle([{ url: "https://a.com" }])).toBeNull();
  });
});

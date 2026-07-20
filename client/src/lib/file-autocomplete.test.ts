import { describe, expect, test } from "bun:test";
import type { FileInfo, ModelOption } from "@pantoken/protocol";
import {
  buildAtItems,
  classifyAtQuery,
  extractAtQuery,
  filterFiles,
  filterModels,
  filterNames,
  splitExternalQuery,
  staleServerFiles,
  stepLevel,
  type AtItem,
  type CachedServerFiles,
  type FreshServerFiles,
} from "./file-autocomplete.js";

describe("extractAtQuery", () => {
  test("returns the text after @ at cursor position", () => {
    const r = extractAtQuery("hello @file.ts", 14);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("file.ts");
    expect(r!.atPos).toBe(6);
  });

  test("empty query when @ is just typed", () => {
    const r = extractAtQuery("@", 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
    expect(r!.atPos).toBe(0);
  });

  test("returns null when there is no @", () => {
    expect(extractAtQuery("hello world", 5)).toBeNull();
  });

  test("returns null for email-like @ (embedded in a word)", () => {
    expect(extractAtQuery("email@domain.com", 13)).toBeNull();
  });

  test("@ at a token boundary (after space) is valid", () => {
    const r = extractAtQuery("review @src/foo", 15);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src/foo");
    expect(r!.atPos).toBe(7);
  });

  test("@ after comma is a token boundary", () => {
    const r = extractAtQuery("check,@test", 11);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("test");
  });

  test("returns only the active token, not a later @", () => {
    // "@one some @two" with cursor right after "@one" (pos 4, before the space)
    // → query is just "one"; the later @two is irrelevant.
    const r = extractAtQuery("@one some @two", 4);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("one");
    expect(r!.atPos).toBe(0);
  });

  test("whitespace inside the token closes the mention", () => {
    // Cursor past a space after the mention ("@one some|") — the mention ended
    // at the space, so this is plain prose, not an active mention. Guards the
    // runaway-fd bug: without this, every word typed after a mention re-queries.
    expect(extractAtQuery("@one some", 9)).toBeNull();
    expect(extractAtQuery("@README.md explain", 18)).toBeNull();
  });

  test("cursor before the @ returns null", () => {
    expect(extractAtQuery("before @after", 3)).toBeNull();
  });

  test("whitespace after @ closes the token (not a mention)", () => {
    expect(extractAtQuery("@ ", 2)).toBeNull();
    expect(extractAtQuery("@\t", 2)).toBeNull();
  });

  test("slash mode at position 0 suppresses @ at the start", () => {
    // "/@foo" with cursor at 5 — slash takes priority
    expect(extractAtQuery("/@foo", 5)).toBeNull();
  });

  test("@ after slash-command arg is valid", () => {
    // "/review @src" with cursor at 13 — slash settled, @ is file mention
    const r = extractAtQuery("/review @src", 13);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("src");
    expect(r!.atPos).toBe(8);
  });

  test("cursor at the exact @ position returns empty query", () => {
    const r = extractAtQuery("@", 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("");
  });

  test("partial typing after @ works", () => {
    const r = extractAtQuery("check @serv", 11);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("serv");
    expect(r!.atPos).toBe(6);
  });

  test("empty draft returns null", () => {
    expect(extractAtQuery("", 0)).toBeNull();
  });

  test("cursor clamped to draft length", () => {
    const r = extractAtQuery("@file", 999);
    expect(r).not.toBeNull();
    expect(r!.query).toBe("file");
  });
});

describe("filterFiles", () => {
  const f = (path: string, isDirectory = false): FileInfo => ({
    path,
    isDirectory,
  });
  const FILES: readonly FileInfo[] = [
    f("README.md"),
    f("store", true),
    f("store.ts"),
    f("lib/mystore.ts"),
    f("server", true),
    f("server/src/hub.ts"),
    f("docs/DESIGN.md"),
  ];
  const paths = (items: FileInfo[]) => items.map((i) => i.path);

  test("empty query returns the head of the index (bare @)", () => {
    expect(paths(filterFiles(FILES, "", 3))).toEqual([
      "README.md",
      "store",
      "store.ts",
    ]);
  });

  test("substring match drops non-matches", () => {
    // "hub" is a subsequence of "server/src/hub.ts" only.
    expect(paths(filterFiles(FILES, "hub"))).toEqual(["server/src/hub.ts"]);
  });

  test("match is case-insensitive", () => {
    expect(paths(filterFiles(FILES, "HUB"))).toEqual(["server/src/hub.ts"]);
  });

  test("ranks path-prefix > basename-prefix > interior (fuzzy)", () => {
    // "store": path-prefix (store, store.ts) before interior (lib/mystore.ts).
    // store and store.ts are both tier 0 (path starts with "store"); alphabetical
    // puts the shorter "store" first. lib/mystore.ts is tier 4 (fuzzy interior).
    expect(paths(filterFiles(FILES, "store"))).toEqual([
      "store", // path-prefix, alphabetical first
      "store.ts", // path-prefix, alphabetical second
      "lib/mystore.ts", // fuzzy interior match → last
    ]);
  });

  test("path-prefix outranks an interior match", () => {
    const files = [f("lib/observer.ts"), f("server/src/hub.ts")];
    // "server": path-prefix on the second; fuzzy interior (inside "observer") on the first.
    expect(paths(filterFiles(files, "server"))).toEqual([
      "server/src/hub.ts",
      "lib/observer.ts",
    ]);
  });

  test("respects the limit", () => {
    expect(filterFiles(FILES, "", 2)).toHaveLength(2);
    const manyTs = [f("a.ts"), f("b.ts"), f("c.ts"), f("d.ts")];
    expect(filterFiles(manyTs, ".ts", 2)).toHaveLength(2);
  });

  test("no match returns empty", () => {
    expect(filterFiles(FILES, "zzz")).toEqual([]);
  });

  // ── Edge-case tests from the at-mention fixture comparison (issue #63) ──
  // These encode the agreed behavior (mimic polytoken's TUI) as a regression
  // guard. Each test mirrors a file structure from parity/fixtures/at-mention-fixture/
  // and asserts the exact ranked order observed in the polytoken TUI.

  test("test_case_sensitivity — lowercase, mixed, and ALL CAPS all match case-insensitively", () => {
    const files: readonly FileInfo[] = [
      f("server.rs"),
      f("caps/Server.rs"),
      f("docs/server-selection-rest-api.md"),
      f("src/server/", true),
      f("src/server/lookup.rs"),
    ];
    // All three case variants produce the same ordering — polytoken is
    // case-insensitive for file matching.
    const expected = [
      "server.rs",
      "caps/Server.rs",
      "docs/server-selection-rest-api.md",
      "src/server/",
      "src/server/lookup.rs",
    ];
    expect(paths(filterFiles(files, "server"))).toEqual(expected);
    expect(paths(filterFiles(files, "Server"))).toEqual(expected);
    expect(paths(filterFiles(files, "SERVER"))).toEqual(expected);
  });

  test("test_cross_dir_deranking — basename-prefix outranks segment-prefix", () => {
    // "server": server.rs is path-prefix (tier 0); caps/Server.rs and
    // docs/server-selection-rest-api.md are basename-prefix (tier 1);
    // src/server/ is basename-prefix (tier 1); src/server/lookup.rs is
    // segment-prefix (tier 2, "server" is an interior segment, basename
    // "lookup.rs" does not start with "server"). Tier order determines ranking.
    const files: readonly FileInfo[] = [
      f("src/server/lookup.rs"),
      f("src/server/", true),
      f("docs/server-selection-rest-api.md"),
      f("caps/Server.rs"),
      f("server.rs"),
    ];
    expect(paths(filterFiles(files, "server"))).toEqual([
      "server.rs", // tier 0: path-prefix
      "caps/Server.rs", // tier 1: basename-prefix (alphabetical)
      "docs/server-selection-rest-api.md", // tier 1: basename-prefix
      "src/server/", // tier 1: basename-prefix
      "src/server/lookup.rs", // tier 2: segment-prefix (interior segment)
    ]);
  });

  test("test_suffix_matching — suffix matches via fuzzy subsequence", () => {
    // "test": test-utils.ts and utils-test.ts both match. test-utils.ts is
    // path-prefix (tier 0); utils-test.ts is segment-prefix (tier 2, "test"
    // at the start of the basename after "utils-"). Wait — "utils-test.ts"
    // basename starts with "utils", not "test". "test" appears after the "-"
    // separator → tier 3 (word-boundary). docs/server-selection-rest-api.md
    // matches "test" as a fuzzy subsequence (t-e-s-t in "rest-api"? no —
    // in "selection-rest-api": t in "selection", e in "rest", s in "rest",
    // t in "rest" → fuzzy tier 4).
    const files: readonly FileInfo[] = [
      f("docs/server-selection-rest-api.md"),
      f("utils-test.ts"),
      f("test-utils.ts"),
    ];
    expect(paths(filterFiles(files, "test"))).toEqual([
      "test-utils.ts", // tier 0: path-prefix
      "utils-test.ts", // tier 3: word-boundary (after "-")
      "docs/server-selection-rest-api.md", // tier 4: fuzzy
    ]);
  });

  test("test_typo_leniency — fuzzy matching catches transposition typos", () => {
    // "srselrs" (scrambled "src/selection.rs") matches via fuzzy subsequence.
    // "servre" (transposition of "server") matches "server-selection-rest-api".
    // "conifg" (transposition of "config") matches nothing — no path has the
    // right subsequence.
    const files: readonly FileInfo[] = [
      f("src/selection.rs"),
      f("src/server/lookup.rs"),
      f("docs/server-selection-rest-api.md"),
      f("config.ts"),
    ];
    // srselrs → s-r-s-e-l-r-s: matches src/selection.rs (s,r,c,/,s,e,l,...,r,s)
    expect(paths(filterFiles(files, "srselrs"))).toEqual([
      "src/selection.rs",
      "src/server/lookup.rs",
      "docs/server-selection-rest-api.md",
    ]);
    // servre → s-e-r-v-r-e: matches docs/server-selection-rest-api.md
    expect(paths(filterFiles(files, "servre"))).toEqual([
      "docs/server-selection-rest-api.md",
    ]);
    // conifg → c-o-n-i-f-g: no path contains this subsequence
    // (config.ts = c-o-n-f-i-g; "conifg" needs 'i' before 'f', but "config"
    // has 'f' before 'i' → no subsequence match)
    expect(paths(filterFiles(files, "conifg"))).toEqual([]);
  });

  test("test_dir_before_file_tiebreaker — alphabetical within same tier (no dir preference)", () => {
    // Polytoken does NOT rank directories before files within the same tier.
    // Same-tier matches break purely alphabetically by path.
    // "index": index/ (dir, tier 0) and index/deep.ts (file, tier 0) both
    // start with "index". Alphabetical: "index/" < "index/deep.ts" (shorter
    // prefix sorts first). Then client/index.ts and src/index.ts (both tier 1,
    // basename-prefix) sort alphabetically by directory: "client" < "src".
    const files: readonly FileInfo[] = [
      f("src/index.ts"),
      f("client/index.ts"),
      f("index/deep.ts"),
      f("index/", true),
    ];
    expect(paths(filterFiles(files, "index"))).toEqual([
      "index/", // tier 0, alphabetical first (shorter string)
      "index/deep.ts", // tier 0, alphabetical second
      "client/index.ts", // tier 1 (basename-prefix), "client" < "src"
      "src/index.ts", // tier 1 (basename-prefix)
    ]);
  });

  test("test_trailing_slash — directory drill-down shows dir + children", () => {
    // A trailing slash in the query triggers directory drill-down: the matching
    // directory and its immediate children are shown.
    const files: readonly FileInfo[] = [
      f("index/", true),
      f("index/deep.ts"),
      f("index/deep/nested.ts"), // not an immediate child (2 levels deep)
      f("client/index.ts"), // not a child of index/
    ];
    expect(paths(filterFiles(files, "index/"))).toEqual([
      "index/",
      "index/deep.ts",
    ]);
  });

  test("test_dotfile_handling — dotfiles hidden in default mode, visible with include_ignored", () => {
    // Dotfiles are excluded from the file index by default (the server's
    // GET /files hides them). When present in the index (include_ignored),
    // they match normally. The .env file is gitignored, .eslintrc.json is
    // a visible dotfile. Both only appear when the toggle is on.
    const files: readonly FileInfo[] = [
      f(".env"),
      f(".eslintrc.json"),
      f("config.ts"),
    ];
    // ".env" matches .env (path-prefix) only — .eslintrc.json has no 'v'.
    expect(paths(filterFiles(files, ".env"))).toEqual([".env"]);
    // ".esl" matches .eslintrc.json (path-prefix) only.
    expect(paths(filterFiles(files, ".esl"))).toEqual([".eslintrc.json"]);
  });

  test("test_gitignored_files — gitignored files only match when in the index", () => {
    // The filterFiles function only sees what's in the index. Gitignored files
    // (dist/bundle.js, server.log) are excluded by the server's GET /files in
    // default mode. When include_ignored is on, they appear in the index and
    // match normally. This test verifies filterFiles handles them correctly
    // when they ARE in the index.
    const filesWithIgnored: readonly FileInfo[] = [
      f("dist/bundle.js"),
      f("server.log"),
      f("server.rs"),
    ];
    expect(paths(filterFiles(filesWithIgnored, "bundle"))).toEqual([
      "dist/bundle.js",
    ]);
    expect(paths(filterFiles(filesWithIgnored, "server"))).toEqual([
      "server.log", // tier 0: path-prefix
      "server.rs", // tier 0: path-prefix (alphabetical: "server.log" < "server.rs")
    ]);
  });
});

describe("classifyAtQuery", () => {
  test("skill: long form", () => {
    expect(classifyAtQuery("skill:debug")).toEqual({
      mode: "skill",
      partial: "debug",
    });
  });

  test("s: shorthand", () => {
    expect(classifyAtQuery("s:debug")).toEqual({
      mode: "skill",
      partial: "debug",
    });
  });

  test("subagent: long form", () => {
    expect(classifyAtQuery("subagent:reviewer")).toEqual({
      mode: "subagent",
      partial: "reviewer",
    });
  });

  test("a: shorthand", () => {
    expect(classifyAtQuery("a:reviewer")).toEqual({
      mode: "subagent",
      partial: "reviewer",
    });
  });

  test("model: long form", () => {
    expect(classifyAtQuery("model:anthropic/claude-opus-4-8")).toEqual({
      mode: "model",
      partial: "anthropic/claude-opus-4-8",
    });
  });

  test("m: shorthand", () => {
    expect(classifyAtQuery("m:sonnet")).toEqual({
      mode: "model",
      partial: "sonnet",
    });
  });

  test("external: leading slash", () => {
    expect(classifyAtQuery("/etc/hosts")).toEqual({
      mode: "external",
      raw: "/etc/hosts",
    });
  });

  test("external: leading tilde", () => {
    expect(classifyAtQuery("~/Documents")).toEqual({
      mode: "external",
      raw: "~/Documents",
    });
  });

  test("external: leading ..", () => {
    expect(classifyAtQuery("../sibling/file.ts")).toEqual({
      mode: "external",
      raw: "../sibling/file.ts",
    });
  });

  test("bare shorthand letters without a colon are project queries", () => {
    expect(classifyAtQuery("s")).toEqual({ mode: "project", partial: "s" });
    expect(classifyAtQuery("a")).toEqual({ mode: "project", partial: "a" });
    expect(classifyAtQuery("m")).toEqual({ mode: "project", partial: "m" });
  });

  test("sigils are case-sensitive lowercase — mixed case falls through to project", () => {
    expect(classifyAtQuery("Skill:debug")).toEqual({
      mode: "project",
      partial: "Skill:debug",
    });
    expect(classifyAtQuery("S:debug")).toEqual({
      mode: "project",
      partial: "S:debug",
    });
  });

  test("an ordinary path is a project query", () => {
    expect(classifyAtQuery("src/foo.ts")).toEqual({
      mode: "project",
      partial: "src/foo.ts",
    });
  });

  test("empty query is a project query with an empty partial", () => {
    expect(classifyAtQuery("")).toEqual({ mode: "project", partial: "" });
  });
});

describe("filterNames", () => {
  const NAMES = ["debug", "journal", "reviewer", "explorer"];

  test("empty partial returns the head of the list as-given", () => {
    expect(filterNames(NAMES, "", 2)).toEqual(["debug", "journal"]);
  });

  test("case-insensitive substring match", () => {
    expect(filterNames(NAMES, "REV")).toEqual(["reviewer"]);
  });

  test("name-start match ranks before an interior match", () => {
    // "explorer" starts with "exp"; "reviewer" doesn't contain it at all — pick a
    // query that's an interior match for one name and a start match for another.
    expect(filterNames(["subreview", "reviewer"], "review")).toEqual([
      "reviewer", // start-of-name match
      "subreview", // interior match
    ]);
  });

  test("ties break alphabetically", () => {
    expect(filterNames(["zeta", "alpha"], "a")).toEqual(["alpha", "zeta"]);
  });

  test("respects the limit", () => {
    const many = ["x1", "x2", "x3", "x4", "x5", "x6", "x7"];
    expect(filterNames(many, "x", 5)).toEqual(["x1", "x2", "x3", "x4", "x5"]);
  });

  test("no match returns empty", () => {
    expect(filterNames(NAMES, "zzz")).toEqual([]);
  });
});

describe("filterModels", () => {
  const m = (
    provider: string,
    modelId: string,
    label: string,
  ): ModelOption => ({ provider, modelId, label });
  const MODELS: readonly ModelOption[] = [
    m("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
    m("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"),
    m("openai", "gpt-5", "GPT-5"),
  ];
  const ids = (items: ModelOption[]) => items.map((i) => i.modelId);

  test("empty partial returns the head of the list as-given", () => {
    expect(ids(filterModels(MODELS, "", 2))).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
  });

  test("matches modelId", () => {
    expect(ids(filterModels(MODELS, "gpt"))).toEqual(["gpt-5"]);
  });

  test("matches label (case-insensitive)", () => {
    expect(ids(filterModels(MODELS, "opus"))).toEqual(["claude-opus-4-8"]);
  });

  test("matches provider/modelId", () => {
    expect(ids(filterModels(MODELS, "anthropic/claude-sonnet"))).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  test("ranks a modelId-start match before an interior/label-only match", () => {
    const models = [
      m("x", "gpt-5", "GPT-5"), // label contains "5", modelId starts with "gpt", not "5"
      m("x", "5-flash", "Five Flash"), // modelId starts with "5"
    ];
    expect(ids(filterModels(models, "5"))).toEqual(["5-flash", "gpt-5"]);
  });

  test("respects the limit", () => {
    expect(filterModels(MODELS, "", 1)).toHaveLength(1);
  });

  test("no match returns empty", () => {
    expect(filterModels(MODELS, "zzz")).toEqual([]);
  });
});

describe("stepLevel", () => {
  const LEVELS = ["off", "low", "medium", "high"] as const;

  test("undefined levels always yield null", () => {
    expect(stepLevel(undefined, null, 1)).toBeNull();
    expect(stepLevel(undefined, "high", -1)).toBeNull();
  });

  test("empty levels always yield null", () => {
    expect(stepLevel([], null, 1)).toBeNull();
    expect(stepLevel([], "high", -1)).toBeNull();
  });

  test("] steps null to the first level, then onward", () => {
    let level = stepLevel(LEVELS, null, 1);
    expect(level).toBe("off");
    level = stepLevel(LEVELS, level, 1);
    expect(level).toBe("low");
    level = stepLevel(LEVELS, level, 1);
    expect(level).toBe("medium");
  });

  test("] clamps at the top level instead of wrapping to null", () => {
    expect(stepLevel(LEVELS, "high", 1)).toBe("high");
  });

  test("[ steps down through the levels", () => {
    expect(stepLevel(LEVELS, "high", -1)).toBe("medium");
    expect(stepLevel(LEVELS, "medium", -1)).toBe("low");
  });

  test("[ steps past the first level back to null", () => {
    expect(stepLevel(LEVELS, "off", -1)).toBeNull();
  });

  test("[ on null stays null (already at the floor)", () => {
    expect(stepLevel(LEVELS, null, -1)).toBeNull();
  });

  test("a single-level list clamps immediately", () => {
    expect(stepLevel(["off"], null, 1)).toBe("off");
    expect(stepLevel(["off"], "off", 1)).toBe("off");
    expect(stepLevel(["off"], "off", -1)).toBeNull();
  });

  test("a stale current not present in levels is treated as null", () => {
    expect(stepLevel(LEVELS, "extreme", 1)).toBe("off");
    expect(stepLevel(LEVELS, "extreme", -1)).toBeNull();
  });
});

describe("buildAtItems", () => {
  const f = (path: string, isDirectory = false): FileInfo => ({
    path,
    isDirectory,
  });
  const m = (
    provider: string,
    modelId: string,
    label: string,
  ): ModelOption => ({ provider, modelId, label });

  const SKILLS = ["debug", "journal"];
  const SUBAGENTS = ["reviewer", "explorer"];
  const MODELS: readonly ModelOption[] = [
    m("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
    m("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6"),
    m("openai", "gpt-5", "GPT-5"),
  ];
  const FILES: readonly FileInfo[] = [
    f("README.md"),
    f("store", true),
    f("store.ts"),
  ];

  const base = {
    files: FILES,
    serverFiles: [] as readonly FileInfo[],
    skills: SKILLS,
    subagents: SUBAGENTS,
    models: MODELS,
  };

  test("skill mode is a full takeover — only skill items, filtered", () => {
    const items = buildAtItems({ ...base, query: "skill:jo" });
    expect(items).toEqual([
      { kind: "skill", name: "journal" },
    ] satisfies AtItem[]);
  });

  test("subagent mode via shorthand is a full takeover", () => {
    const items = buildAtItems({ ...base, query: "a:rev" });
    expect(items).toEqual([
      { kind: "subagent", name: "reviewer" },
    ] satisfies AtItem[]);
  });

  test("model mode is a full takeover", () => {
    const items = buildAtItems({ ...base, query: "m:sonnet" });
    expect(items).toEqual([
      { kind: "model", model: MODELS[1] },
    ] satisfies AtItem[]);
  });

  test("takeover mode with an empty partial returns the whole kind list", () => {
    const items = buildAtItems({ ...base, query: "skill:" });
    expect(items).toEqual([
      { kind: "skill", name: "debug" },
      { kind: "skill", name: "journal" },
    ] satisfies AtItem[]);
  });

  test("external mode with no server results yet: empty (never falls back to the local index)", () => {
    expect(buildAtItems({ ...base, query: "~/Documents" })).toEqual([]);
    expect(buildAtItems({ ...base, query: "/etc/hosts" })).toEqual([]);
    expect(buildAtItems({ ...base, query: "../sibling" })).toEqual([]);
  });

  test("external mode maps server-resolved files straight to file rows — no badges, no sigils", () => {
    const external = [f("~/notes.md"), f("~/projects", true)];
    const items = buildAtItems({ ...base, query: "~/", serverFiles: external });
    expect(items).toEqual([
      { kind: "file", file: f("~/notes.md") },
      { kind: "file", file: f("~/projects", true) },
    ] satisfies AtItem[]);
  });

  test("external mode ignores the local file index entirely, even when it would match", () => {
    // `files` (the local project index) is deliberately irrelevant here — a query
    // like "~/README" must never surface the local index's "README.md".
    const items = buildAtItems({
      ...base,
      query: "~/README",
      serverFiles: [f("~/README.md")],
    });
    expect(items).toEqual([
      { kind: "file", file: f("~/README.md") },
    ] satisfies AtItem[]);
  });

  test("external mode caps results at `limit`", () => {
    const many = Array.from({ length: 5 }, (_, i) => f(`~/file${i}.txt`));
    const items = buildAtItems({
      ...base,
      query: "~/",
      serverFiles: many,
      limit: 3,
    });
    expect(items).toHaveLength(3);
  });

  test("bare @ (empty partial): files only, no kind noise, no sigils", () => {
    const items = buildAtItems({ ...base, query: "" });
    expect(items).toEqual([
      { kind: "file", file: f("README.md") },
      { kind: "file", file: f("store", true) },
      { kind: "file", file: f("store.ts") },
    ] satisfies AtItem[]);
  });

  test("bare @ with zero file candidates falls back to the sigil rows", () => {
    // Empty/unindexed cwd: no files at all for a bare `@`. Without the fallback this
    // would be an empty menu (no way to discover skill:/subagent:/model:).
    const items = buildAtItems({
      files: [],
      serverFiles: [],
      skills: SKILLS,
      subagents: SUBAGENTS,
      models: MODELS,
      query: "",
    });
    expect(items).toEqual([
      { kind: "sigil", prefix: "skill:", label: "browse skills…" },
      { kind: "sigil", prefix: "subagent:", label: "browse subagents…" },
      { kind: "sigil", prefix: "model:", label: "browse models…" },
    ] satisfies AtItem[]);
  });

  test("bare @ with zero files AND empty skill/subagent lists still offers model: (always available)", () => {
    const items = buildAtItems({
      files: [],
      serverFiles: [],
      skills: [],
      subagents: [],
      models: [],
      query: "",
    });
    expect(items).toEqual([
      { kind: "sigil", prefix: "model:", label: "browse models…" },
    ] satisfies AtItem[]);
  });

  test("bare @ with server file extras (but no local index) is not treated as zero candidates", () => {
    // serverFiles alone should suppress the sigil fallback just like local files do —
    // there IS something to show, so don't also inject sigil noise.
    const items = buildAtItems({
      files: [],
      serverFiles: [f("README.md")],
      skills: SKILLS,
      subagents: SUBAGENTS,
      models: MODELS,
      query: "",
    });
    expect(items).toEqual([
      { kind: "file", file: f("README.md") },
    ] satisfies AtItem[]);
  });

  test("'sk' shows the skill: sigil after file matches, but not subagent:/model:", () => {
    const items = buildAtItems({
      files: [f("skills-doc.md"), f("readme.md")],
      serverFiles: [],
      skills: SKILLS, // neither "debug" nor "journal" contains "sk"
      subagents: SUBAGENTS, // neither contains "sk"
      models: MODELS, // none contain "sk"
      query: "sk",
    });
    expect(items).toEqual([
      { kind: "file", file: f("skills-doc.md") },
      { kind: "sigil", prefix: "skill:", label: "browse skills…" },
    ] satisfies AtItem[]);
  });

  test("'s' matches both the skill: and subagent: sigils (not model:)", () => {
    const items = buildAtItems({
      files: [f("readme.md")], // no "s" in "readme.md"
      serverFiles: [],
      skills: SKILLS, // no "s" in "debug"/"journal"
      subagents: SUBAGENTS, // no "s" in "reviewer"/"explorer"
      models: [],
      query: "s",
    });
    expect(items).toEqual([
      { kind: "sigil", prefix: "skill:", label: "browse skills…" },
      { kind: "sigil", prefix: "subagent:", label: "browse subagents…" },
    ] satisfies AtItem[]);
  });

  test("empty skill/subagent lists suppress their sigils; model: sigil is exempt", () => {
    const items = buildAtItems({
      files: [],
      serverFiles: [],
      skills: [],
      subagents: [],
      models: [], // still offers the model: sigil — models are always available
      query: "m",
    });
    expect(items).toEqual([
      { kind: "sigil", prefix: "model:", label: "browse models…" },
    ] satisfies AtItem[]);

    const noSigils = buildAtItems({
      files: [],
      serverFiles: [],
      skills: [],
      subagents: [],
      models: [],
      query: "s",
    });
    expect(noSigils).toEqual([]);
  });

  test("project mode appends badged skill/subagent/model matches after files, sigils last", () => {
    const items = buildAtItems({
      files: [f("modelo.txt")], // matches "model" as an interior/prefix substring
      serverFiles: [],
      skills: ["model-skill"],
      subagents: ["model-agent"],
      models: [m("x", "model-9", "Model Nine")],
      query: "model",
    });
    expect(items).toEqual([
      { kind: "file", file: f("modelo.txt") },
      { kind: "skill", name: "model-skill" },
      { kind: "subagent", name: "model-agent" },
      { kind: "model", model: m("x", "model-9", "Model Nine") },
      { kind: "sigil", prefix: "model:", label: "browse models…" },
    ] satisfies AtItem[]);
  });

  test("badged matches per kind are capped at 5, alphabetical among equal ranks", () => {
    const manySkills = ["x7", "x1", "x6", "x2", "x5", "x3", "x4"];
    const items = buildAtItems({
      files: [],
      serverFiles: [],
      skills: manySkills,
      subagents: [],
      models: [],
      query: "x",
    });
    // No file "x" matches, no subagents, no models — just the capped, sorted skill
    // badges (no sigil: "x" isn't a prefix of any sigil word).
    expect(items).toEqual([
      { kind: "skill", name: "x1" },
      { kind: "skill", name: "x2" },
      { kind: "skill", name: "x3" },
      { kind: "skill", name: "x4" },
      { kind: "skill", name: "x5" },
    ] satisfies AtItem[]);
  });

  test("server file extras are merged in after local matches, deduped by path", () => {
    const items = buildAtItems({
      files: [f("foo/a.ts")],
      serverFiles: [f("foo/a.ts"), f("bar/a.ts")],
      skills: [],
      subagents: [],
      models: [],
      query: "a.ts",
    });
    expect(items).toEqual([
      { kind: "file", file: f("foo/a.ts") },
      { kind: "file", file: f("bar/a.ts") },
    ] satisfies AtItem[]);
  });
});

describe("splitExternalQuery", () => {
  test("bare tilde is the dir-prefix, empty partial", () => {
    expect(splitExternalQuery("~")).toEqual({ dirPrefix: "~", partial: "" });
  });
  test("bare .. is the dir-prefix, empty partial", () => {
    expect(splitExternalQuery("..")).toEqual({ dirPrefix: "..", partial: "" });
  });
  test("trailing slash: dir-prefix, empty partial", () => {
    expect(splitExternalQuery("~/projects/")).toEqual({
      dirPrefix: "~/projects",
      partial: "",
    });
  });
  test("root-anchored single segment keeps / as dir-prefix", () => {
    expect(splitExternalQuery("/etc")).toEqual({ dirPrefix: "/", partial: "etc" });
  });
  test("root-anchored dir + partial", () => {
    expect(splitExternalQuery("/etc/ho")).toEqual({
      dirPrefix: "/etc",
      partial: "ho",
    });
  });
  test("tilde dir + partial", () => {
    expect(splitExternalQuery("~/proj")).toEqual({
      dirPrefix: "~",
      partial: "proj",
    });
  });
});

describe("staleServerFiles", () => {
  const f = (path: string, isDirectory = false): FileInfo => ({
    path,
    isDirectory,
  });

  // External-mode fixtures: the synthetic `~` home's children (mock_external_tree).
  const HOME_CHILDREN: readonly FileInfo[] = [
    f("~/notes.md"),
    f("~/todo.txt"),
    f("~/projects", true),
  ];

  const fresh = (items: readonly FileInfo[], query: string, includeIgnored = false): FreshServerFiles => ({
    items,
    query,
    includeIgnored,
  });

  const cache = (
    files: readonly FileInfo[],
    query: string,
    mode: "external" | "project",
    includeIgnored = false,
  ): CachedServerFiles => ({
    files,
    query,
    mode,
    includeIgnored,
  });

  test("AC.3 — fresh match returns fresh.items, not the re-filtered cache", () => {
    const cached = cache(HOME_CHILDREN, "~/", "external");
    // The fresh response matches the current query + toggle → return fresh items.
    const result = staleServerFiles(
      fresh(HOME_CHILDREN, "~/p", false),
      cached,
      "~/p",
      "external",
      false,
    );
    expect(result).toBe(HOME_CHILDREN);
  });

  test("AC.2 — external in-flight: re-filters cached results by the trailing partial", () => {
    // Cached results answered `~/` (all home children). Now the user typed `~/p`
    // — the fresh response hasn't arrived yet, so re-filter the cache by "p".
    const cached = cache(HOME_CHILDREN, "~/", "external");
    const result = staleServerFiles(
      fresh([], "~/old", false), // stale: server still echoes the old query
      cached,
      "~/p",
      "external",
      false,
    );
    const paths = result.map((r) => r.path);
    // Only ~/projects contains "p" as a substring.
    expect(paths).toEqual(["~/projects"]);
  });

  test("AC.2 — external in-flight: narrowing further re-filters by the new partial", () => {
    // Cached answered `~/p` → only ~/projects matched. Now typing `~/pr` — re-filter
    // the cached ~/projects by "pr".
    const cached = cache([f("~/projects", true)], "~/p", "external");
    const result = staleServerFiles(
      fresh([], "~/p", false), // stale
      cached,
      "~/pr",
      "external",
      false,
    );
    const paths = result.map((r) => r.path);
    expect(paths).toEqual(["~/projects"]);
  });

  test("AC.2 — external in-flight: a partial that matches nothing returns empty", () => {
    const cached = cache(HOME_CHILDREN, "~/", "external");
    const result = staleServerFiles(
      fresh([], "~/old", false),
      cached,
      "~/zzz",
      "external",
      false,
    );
    expect(result).toEqual([]);
  });

  test("AC.2 — external empty partial (same dir listing): returns cached head unchanged", () => {
    // Cached answered `~/` (empty partial). User re-types `~/` — same dir-prefix,
    // empty partial → filterFiles returns the cached head.
    const cached = cache(HOME_CHILDREN, "~/", "external");
    const result = staleServerFiles(
      fresh([], "~/old", false),
      cached,
      "~/",
      "external",
      false,
    );
    expect(result.map((r) => r.path)).toEqual([
      "~/notes.md",
      "~/todo.txt",
      "~/projects",
    ]);
  });

  test("AC.5 — external drill-down (dir-prefix change) returns []", () => {
    // Cache holds `~`'s children (~/notes.md, ~/todo.txt, ~/projects).
    // User accepted ~/projects/ and is now browsing ~/projects/blog — the cache's
    // dir-prefix is `~`, the current query's is `~/projects` → mismatch → [].
    const cached = cache(HOME_CHILDREN, "~/", "external");
    const result = staleServerFiles(
      fresh([], "~/old", false),
      cached,
      "~/projects/b",
      "external",
      false,
    );
    expect(result).toEqual([]);
  });

  test("AC.5 — external drill-down: empty partial on a different dir still returns []", () => {
    // Even with an empty partial (bare `~/projects/`), the dir-prefix guard fires
    // first — the parent dir's children must not show as candidates for the new dir.
    const cached = cache(HOME_CHILDREN, "~/", "external");
    const result = staleServerFiles(
      fresh([], "~/old", false),
      cached,
      "~/projects/",
      "external",
      false,
    );
    expect(result).toEqual([]);
  });

  test("AC.2 — project mode in-flight: re-filters cached results by the full query", () => {
    // Project-mode server results are full-tree path matches, so re-filter by the
    // full atQ (no dir-prefix guard, no partial split).
    const cachedFiles: readonly FileInfo[] = [
      f("src/server.ts"),
      f("src/client.ts"),
      f("lib/utils.ts"),
    ];
    const cached = cache(cachedFiles, "serv", "project");
    const result = staleServerFiles(
      fresh([], "old", false), // stale
      cached,
      "server",
      "project",
      false,
    );
    expect(result.map((r) => r.path)).toEqual(["src/server.ts"]);
  });

  test("AC.3 — project mode fresh match returns fresh.items", () => {
    const cachedFiles: readonly FileInfo[] = [f("src/old.ts")];
    const cached = cache(cachedFiles, "old", "project");
    const freshItems: readonly FileInfo[] = [f("src/server.ts")];
    const result = staleServerFiles(
      fresh(freshItems, "server", false),
      cached,
      "server",
      "project",
      false,
    );
    expect(result).toBe(freshItems);
  });

  test("AC.6 — cross-mode isolation: project cache is ignored in external mode", () => {
    const cached = cache([f("src/server.ts")], "serv", "project");
    const result = staleServerFiles(
      fresh([], "~/old", false), // stale
      cached,
      "~/s",
      "external",
      false,
    );
    expect(result).toEqual([]);
  });

  test("AC.6 — cross-mode isolation: external cache is ignored in project mode", () => {
    const cached = cache(HOME_CHILDREN, "~/", "external");
    const result = staleServerFiles(
      fresh([], "old", false), // stale
      cached,
      "notes",
      "project",
      false,
    );
    expect(result).toEqual([]);
  });

  test("AC.6 — cross-toggle isolation: ignoreOff mismatch skips the cache", () => {
    // Cache has includeIgnored=false. Current ignoreOff=true → skip cache → [].
    const cached = cache(HOME_CHILDREN, "~/", "external", false);
    const result = staleServerFiles(
      fresh([], "~/old", true), // stale (server echoes old query, toggle=true)
      cached,
      "~/p",
      "external",
      true, // current ignoreOff
    );
    expect(result).toEqual([]);
  });

  test("AC.6 — cross-toggle: matching ignoreOff uses the cache", () => {
    // Cache has includeIgnored=true. Current ignoreOff=true → use cache, re-filter.
    // Both ~/projects and ~/.secrets contain "s" as a subsequence, so both match.
    const cached = cache(
      [f("~/projects", true), f("~/.secrets")],
      "~/",
      "external",
      true,
    );
    const result = staleServerFiles(
      fresh([], "~/old", true), // stale
      cached,
      "~/s",
      "external",
      true,
    );
    // With fuzzy matching, ~/.secrets scores higher: "s" matches right after the
    // "." word boundary (position 3), while in ~/projects "s" is at the end (pos 9).
    // Both match; ~/.secrets ranks first by score.
    expect(result.map((r) => r.path)).toEqual(["~/.secrets", "~/projects"]);
  });

  test("no cache (null) returns []", () => {
    const result = staleServerFiles(
      fresh([], "old", false),
      null,
      "~/p",
      "external",
      false,
    );
    expect(result).toEqual([]);
  });

  test("external root-anchored: same dir-prefix re-filters by partial", () => {
    // /etc/ho → dir-prefix /etc, partial "ho". Cache answered /etc/ (dir-prefix
    // /etc, empty partial) → same dir → re-filter by "ho".
    const cached = cache([f("/etc/hosts")], "/etc/", "external");
    const result = staleServerFiles(
      fresh([], "/etc/old", false),
      cached,
      "/etc/ho",
      "external",
      false,
    );
    expect(result.map((r) => r.path)).toEqual(["/etc/hosts"]);
  });

  test("external root-anchored: different dir-prefix returns []", () => {
    // /etc → dir-prefix /. Cache answered / (dir-prefix /) → mismatch with /etc → [].
    const cached = cache([f("/etc")], "/", "external");
    const result = staleServerFiles(
      fresh([], "/old", false),
      cached,
      "/etc/ho",
      "external",
      false,
    );
    expect(result).toEqual([]);
  });
});

# @-mention comparison findings: pantoken `filterFiles` vs polytoken TUI

Session: `06f0q9-cleft` (port 52317), fixture: `parity/fixtures/at-mention-fixture/`
Date: 2026-07-20

## File lists (from `GET /files`)

### Default (Ignores: on — gitignored/dotfiles hidden) — 20 entries
```
README.md, caps/, caps/Server.rs, client/, client/index.ts, config.ts,
configuration.ts, docs/, docs/server-selection-rest-api.md, index/,
index/deep.ts, myconfig.ts, server.rs, src/, src/index.ts, src/selection.rs,
src/server/, src/server/lookup.rs, test-utils.ts, utils-test.ts
```

### Include_ignored (Ignores: off) — 30 entries
adds: `.env`, `.eslintrc.json`, `.gitignore`, `dist/`, `dist/bundle.js`,
`node_modules/`, `node_modules/react/`, `node_modules/react/index.js`,
`server.log`, `src/.config.json`

## Toggle note
- TUI label "Ignores: on" = gitignored files HIDDEN (default)
- TUI label "Ignores: off" = gitignored files SHOWN
- `S-Tab` chord did NOT work through tmux; `BTab` (backward-tab) does.

---

## Matrix — Ignores ON (default, gitignored/dotfiles hidden)

Format: `@query` → TUI order | pantoken filterFiles order
(`|` separates items; skills/subagents/models stripped from TUI output)

### @ (bare)
- **TUI:** README.md, caps/, caps/Server.rs, client/, client/index.ts, config.ts, configuration.ts, docs/ (8 visible, menu capped at viewport)
- **PAN:** (returns head of index = full alphabetical list, 20 items)
- **Note:** Both use fd's alphabetical order. TUI viewport caps at ~8 visible rows.

### @s
- **TUI:** server.rs, src/, src/index.ts, src/selection.rs, src/server/, src/server/lookup.rs
- **PAN:** src/, server.rs, src/server/, src/index.ts, src/selection.rs, src/server/lookup.rs, caps/, docs/, config.ts, myconfig.ts, index/deep.ts, test-utils.ts, utils-test.ts, caps/Server.rs, client/index.ts, configuration.ts, docs/server-selection-rest-api.md
- **Diff:** TUI shows 6 files; pantoken shows 17. TUI excludes files where "s" is only an interior char (caps, docs, config, test-utils, etc.). Ordering also differs (TUI: server.rs first; PAN: src/ first).

### @S
- **TUI:** server.rs, src/, src/index.ts, src/selection.rs, src/server/, src/server/lookup.rs
- **PAN:** src/, server.rs, src/server/, src/index.ts, src/selection.rs, src/server/lookup.rs, caps/, docs/, config.ts, myconfig.ts, index/deep.ts, test-utils.ts, utils-test.ts, caps/Server.rs, client/index.ts, configuration.ts, docs/server-selection-rest-api.md
- **Diff:** Identical to @s on both sides. Case-insensitive on both.

### @server
- **TUI:** server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Diff:** Same 5 files, different order. TUI: server.rs first (basename-prefix). PAN: src/server/ first (path-prefix outranks basename-prefix in current pantoken logic).

### @Server
- **TUI:** server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Diff:** Identical to @server. Case-insensitive on both.

### @SERVER
- **TUI:** server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Diff:** Identical to @server. Case-insensitive on both.

### @config
- **TUI:** config.ts, configuration.ts, myconfig.ts
- **PAN:** config.ts, configuration.ts, myconfig.ts
- **Diff:** ✅ AGREE

### @test
- **TUI:** test-utils.ts, utils-test.ts, docs/server-selection-rest-api.md
- **PAN:** test-utils.ts, utils-test.ts
- **Diff:** TUI includes docs/server-selection-rest-api.md (contains "test" in "rest-api"? No — "server-selection-rest-api" contains "test" as substring in "selec**t**ion-res**t**-api"? Actually "test" appears in "rest-api" as "res**t**-a**pi**"... no. Let me check: "server-selection-rest-api.md" — does it contain "test"? s-e-r-v-e-r---s-e-l-e-c-t-i-o-n---r-e-s-t---a-p-i-.-m-d. "test" = t-e-s-t. In "selection" we have ...c-t-i-o-n... no "test". In "rest" we have r-e-s-t. No "test" substring. BUT the TUI shows it. This suggests polytoken may do fuzzy/word-boundary matching, not substring.)

### @index
- **TUI:** index/, index/deep.ts, client/index.ts, src/index.ts
- **PAN:** index/, src/index.ts, client/index.ts, index/deep.ts
- **Diff:** Same 4 files, different order. TUI: index/deep.ts before client/index.ts and src/index.ts. PAN: src/index.ts first (shorter path), then client/index.ts, then index/deep.ts.

### @src/server
- **TUI:** src/server/, src/server/lookup.rs
- **PAN:** src/server/, src/server/lookup.rs
- **Diff:** ✅ AGREE

### @src/server/look
- **TUI:** src/server/lookup.rs
- **PAN:** src/server/lookup.rs
- **Diff:** ✅ AGREE

### @srselrs
- **TUI:** src/selection.rs, src/server/lookup.rs, docs/server-selection-rest-api.md
- **PAN:** (empty)
- **Diff:** TUI does FUZZY matching — "srselrs" matches "src/selection.rs" (s-r-sel-rs → s**r**c/**sel**e**r**s? or s-r-c/s-e-l-e-c-t-i-o-n-.-r-s). Pantoken does substring matching and finds nothing.

### @.env
- **TUI:** No files, skills, or subagents
- **PAN:** (empty)
- **Diff:** ✅ AGREE (both empty — .env is gitignored, hidden in default mode)

### @.esl
- **TUI:** No files, skills, or subagents
- **PAN:** (empty)
- **Diff:** ✅ AGREE (both empty — .eslintrc.json is a dotfile, hidden in default mode)

### @lookup
- **TUI:** src/server/lookup.rs
- **PAN:** src/server/lookup.rs
- **Diff:** ✅ AGREE

### @selection
- **TUI:** src/selection.rs, docs/server-selection-rest-api.md
- **PAN:** src/selection.rs, docs/server-selection-rest-api.md
- **Diff:** ✅ AGREE

### @bundle
- **TUI:** No files, skills, or subagents
- **PAN:** (empty)
- **Diff:** ✅ AGREE (both empty — dist/bundle.js is gitignored)

### @conifg
- **TUI:** No files, skills, or subagents
- **PAN:** (empty)
- **Diff:** ✅ AGREE (both empty — typo, no fuzzy leniency for "config")

### @servre
- **TUI:** docs/server-selection-rest-api.md
- **PAN:** (empty)
- **Diff:** TUI shows docs/server-selection-rest-api.md for "servre" (typo of "server"). This is fuzzy matching — "servre" → "server-selection-rest-api" (serv-r-e → serv...r...e). Pantoken finds nothing (substring match fails).

### @index/
- **TUI:** index/, index/deep.ts
- **PAN:** index/deep.ts
- **Diff:** TUI includes the directory `index/` itself; pantoken does not (trailing slash stripped from query, "index/" → "index" matches "index/deep.ts" but the dir "index" has path "index" which contains "index" — wait, PAN should match "index" dir too. Let me check: PAN output is just "index/deep.ts". The dir "index/" has path "index" — "index".indexOf("index/") = -1 because the query "index/" has a trailing slash. So pantoken's substring match fails for the directory. TUI treats trailing slash as directory drill-down, showing the dir + its contents.)

---

## Matrix — Ignores OFF (include_ignored=true, gitignored/dotfiles shown)

### @ (bare)
- **TUI:** .env, .eslintrc.json, .gitignore, README.md, caps/, caps/Server.rs, client/, client/index.ts (8 visible)
- **PAN:** (full 30-item alphabetical list)
- **Note:** Both alphabetical. TUI viewport caps at ~8.

### @s
- **TUI:** server.log, server.rs, src/, src/.config.json, src/index.ts, src/selection.rs, src/server/, src/server/lookup.rs
- **PAN:** src/, server.rs, server.log, src/server/, src/index.ts, src/.config.json, src/selection.rs, src/server/lookup.rs, caps/, dist/, docs/, node_modules/, node_modules/react/, config.ts, myconfig.ts, index/deep.ts, test-utils.ts, utils-test.ts, .eslintrc.json, caps/Server.rs, dist/bundle.js, client/index.ts, configuration.ts, node_modules/react/index.js, docs/server-selection-rest-api.md
- **Diff:** TUI shows 8 files; pantoken shows 24. Same pattern as default mode — TUI is more restrictive about what matches.

### @S
- **TUI:** server.log, server.rs, src/, src/.config.json, src/index.ts, src/selection.rs, src/server/, src/server/lookup.rs
- **PAN:** (same as @s)
- **Diff:** Identical to @s. Case-insensitive.

### @server
- **TUI:** server.log, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, server.log, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Diff:** Same 6 files, different order. TUI: server.log, server.rs first. PAN: src/server/ first.

### @Server
- **TUI:** server.log, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, server.log, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Diff:** Identical to @server. Case-insensitive.

### @SERVER
- **TUI:** server.log, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, server.log, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Diff:** Identical to @server. Case-insensitive.

### @config
- **TUI:** config.ts, configuration.ts, src/.config.json, myconfig.ts
- **PAN:** config.ts, configuration.ts, myconfig.ts, src/.config.json
- **Diff:** Same 4 files, different order. TUI: src/.config.json before myconfig.ts. PAN: myconfig.ts before src/.config.json.

### @test
- **TUI:** test-utils.ts, utils-test.ts, docs/server-selection-rest-api.md
- **PAN:** test-utils.ts, utils-test.ts
- **Diff:** TUI includes docs/server-selection-rest-api.md; pantoken doesn't.

### @index
- **TUI:** index/, index/deep.ts, client/index.ts, node_modules/react/index.js, src/index.ts
- **PAN:** index/, src/index.ts, client/index.ts, node_modules/react/index.js, index/deep.ts
- **Diff:** Same 5 files, different order. TUI: index/deep.ts 2nd. PAN: src/index.ts 2nd.

### @src/server
- **TUI:** src/server/, src/server/lookup.rs
- **PAN:** src/server/, src/server/lookup.rs
- **Diff:** ✅ AGREE

### @src/server/look
- **TUI:** src/server/lookup.rs
- **PAN:** src/server/lookup.rs
- **Diff:** ✅ AGREE

### @srselrs
- **TUI:** src/selection.rs, src/server/lookup.rs, docs/server-selection-rest-api.md
- **PAN:** (empty)
- **Diff:** TUI does fuzzy matching; pantoken finds nothing.

### @.env
- **TUI:** .env
- **PAN:** .env
- **Diff:** ✅ AGREE

### @.esl
- **TUI:** .eslintrc.json
- **PAN:** .eslintrc.json
- **Diff:** ✅ AGREE

### @lookup
- **TUI:** src/server/lookup.rs
- **PAN:** src/server/lookup.rs
- **Diff:** ✅ AGREE

### @selection
- **TUI:** src/selection.rs, docs/server-selection-rest-api.md
- **PAN:** src/selection.rs, docs/server-selection-rest-api.md
- **Diff:** ✅ AGREE

### @bundle
- **TUI:** dist/bundle.js
- **PAN:** dist/bundle.js
- **Diff:** ✅ AGREE

### @conifg
- **TUI:** No files, skills, or subagents
- **PAN:** (empty)
- **Diff:** ✅ AGREE (both empty — no fuzzy leniency for "config" typo)

### @servre
- **TUI:** docs/server-selection-rest-api.md
- **PAN:** (empty)
- **Diff:** TUI shows a fuzzy match; pantoken finds nothing.

### @index/
- **TUI:** index/, index/deep.ts
- **PAN:** index/deep.ts
- **Diff:** TUI includes the directory; pantoken doesn't (trailing-slash query issue).

---

## Additional disambiguation queries (Ignores ON only)

### @se
- **TUI:** server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/selection.rs, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, caps/Server.rs, src/selection.rs, docs/server-selection-rest-api.md, src/server/lookup.rs

### @src
- **TUI:** src/, src/index.ts, src/selection.rs, src/server/, src/server/lookup.rs
- **PAN:** src/, src/server/, src/index.ts, src/selection.rs, src/server/lookup.rs

### @selec
- **TUI:** src/selection.rs, docs/server-selection-rest-api.md
- **PAN:** src/selection.rs, docs/server-selection-rest-api.md
- **Diff:** ✅ AGREE

### @serv
- **TUI:** server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/, src/server/lookup.rs
- **PAN:** src/server/, server.rs, caps/Server.rs, docs/server-selection-rest-api.md, src/server/lookup.rs

### @c
- **TUI:** caps/, caps/Server.rs, client/, client/index.ts, config.ts, configuration.ts
- **PAN:** caps/, client/, config.ts, configuration.ts, caps/Server.rs, client/index.ts, src/, docs/, src/server/, myconfig.ts, src/index.ts, src/selection.rs, src/server/lookup.rs, docs/server-selection-rest-api.md
- **Diff:** TUI shows 6 files; pantoken shows 14. TUI more restrictive.

### @ca
- **TUI:** caps/, caps/Server.rs, configuration.ts, docs/server-selection-rest-api.md
- **PAN:** caps/, caps/Server.rs
- **Diff:** TUI shows configuration.ts and docs/server-selection-rest-api.md (fuzzy? "ca" → "configur**a**tion" and "server-selection-rest-**a**pi"?). Pantoken only shows caps/ matches.

### @cap
- **TUI:** caps/, caps/Server.rs, docs/server-selection-rest-api.md
- **PAN:** caps/, caps/Server.rs
- **Diff:** TUI includes docs/server-selection-rest-api.md (fuzzy: "cap" → "server-selection-rest-api"? unclear).

### @co
- **TUI:** config.ts, configuration.ts, myconfig.ts, docs/server-selection-rest-api.md, src/selection.rs
- **PAN:** config.ts, configuration.ts, myconfig.ts
- **Diff:** TUI includes docs/server-selection-rest-api.md and src/selection.rs (fuzzy: "co" → "...rest-api.md"? and "sele**c**ti**o**n"?).

### @con
- **TUI:** config.ts, configuration.ts, myconfig.ts, docs/server-selection-rest-api.md, src/selection.rs
- **PAN:** config.ts, configuration.ts, myconfig.ts
- **Diff:** Same as @co — TUI includes 2 extra fuzzy matches.

### @i
- **TUI:** index/, index/deep.ts, client/index.ts, src/index.ts, client/
- **PAN:** index/, src/index.ts, index/deep.ts, client/, config.ts, myconfig.ts, test-utils.ts, utils-test.ts, client/index.ts, configuration.ts, src/selection.rs, docs/server-selection-rest-api.md
- **Diff:** TUI shows 5 files; pantoken shows 12. TUI more restrictive.

### @in
- **TUI:** index/, index/deep.ts, client/index.ts, src/index.ts
- **PAN:** index/, src/index.ts, client/index.ts, index/deep.ts
- **Diff:** Same 4 files, different order.

### @ind
- **TUI:** index/, index/deep.ts, client/index.ts, src/index.ts, docs/server-selection-rest-api.md
- **PAN:** index/, src/index.ts, client/index.ts, index/deep.ts
- **Diff:** TUI includes docs/server-selection-rest-api.md (fuzzy: "ind" → "...select**i**o**n**-r**e**st-ap**i**"? or "...rest-ap**i**.-m**d**"? unclear).

### @d
- **TUI:** docs/, docs/server-selection-rest-api.md, index/deep.ts, README.md, client/index.ts
- **PAN:** docs/, docs/server-selection-rest-api.md, index/, README.md, src/index.ts, index/deep.ts, client/index.ts
- **Diff:** TUI shows 5 files; pantoken shows 7. TUI excludes index/ and src/index.ts.

### @do
- **TUI:** docs/, docs/server-selection-rest-api.md
- **PAN:** docs/, docs/server-selection-rest-api.md
- **Diff:** ✅ AGREE

### @doc
- **TUI:** docs/, docs/server-selection-rest-api.md
- **PAN:** docs/, docs/server-selection-rest-api.md
- **Diff:** ✅ AGREE

### @t
- **TUI:** test-utils.ts, client/index.ts, config.ts, configuration.ts, index/deep.ts, myconfig.ts, src/index.ts
- **PAN:** test-utils.ts, client/, config.ts, myconfig.ts, src/index.ts, index/deep.ts, utils-test.ts, client/index.ts, configuration.ts, src/selection.rs, docs/server-selection-rest-api.md
- **Diff:** TUI shows 7 files; pantoken shows 11. TUI excludes client/, utils-test.ts, src/selection.rs, docs/server-selection-rest-api.md.

### @te
- **TUI:** test-utils.ts, utils-test.ts
- **PAN:** test-utils.ts, utils-test.ts
- **Diff:** ✅ AGREE

### @u
- **TUI:** utils-test.ts, test-utils.ts, configuration.ts, src/server/lookup.rs
- **PAN:** utils-test.ts, test-utils.ts, configuration.ts, src/server/lookup.rs
- **Diff:** ✅ AGREE

### @ut
- **TUI:** utils-test.ts, test-utils.ts, configuration.ts
- **PAN:** utils-test.ts, test-utils.ts, configuration.ts
- **Diff:** ✅ AGREE

---

## Additional disambiguation queries batch 2 (Ignores ON)

### @do
- **TUI:** docs/, docs/server-selection-rest-api.md
- **PAN:** docs/, docs/server-selection-rest-api.md
- **Diff:** ✅ AGREE

### @e
- **TUI:** README.md, caps/Server.rs, client/, client/index.ts, docs/server-selection-rest-api.md, index/, index/deep.ts
- **PAN:** (not tested, but substring would match many)
- **Note:** TUI shows 7 files. README.md matches "e" — likely fuzzy (E in README at a word/camelCase boundary?). No path/segment starts with "e", so these are all fuzzy/boundary matches.

### @r
- **TUI:** README.md, caps/Server.rs, docs/server-selection-rest-api.md, server.rs, src/selection.rs
- **Note:** 5 files. README.md (R at start), caps/Server.rs (r in Server? or r in caps?), server.rs (r at start), src/selection.rs (r in src?).

### @l
- **TUI:** src/server/lookup.rs, client/, client/index.ts, docs/server-selection-rest-api.md, src/selection.rs, test-utils.ts, utils-test.ts
- **Note:** 7 files. "l" matches lookup (prefix), client (l in client? no, c-l-i-e-n-t, l at pos 1), etc.

### @f
- **TUI:** config.ts, configuration.ts, myconfig.ts
- **Note:** 3 files. "f" matches config (f in config at pos 3), configuration, myconfig. All have "f" in "config". But NOT caps/Server.rs (no "f"), NOT docs/... (no "f"). So "f" matches where "f" appears — but only in "config" words.

### @g
- **TUI:** config.ts, configuration.ts, myconfig.ts
- **Note:** Same as @f. "g" matches "config" (g at end).

### @m
- **TUI:** myconfig.ts, README.md, docs/server-selection-rest-api.md
- **Note:** 3 files. myconfig (m at start), README.md (M in README?), docs/... (m in .md?).

### @n
- **TUI:** client/, client/index.ts, config.ts, configuration.ts, docs/server-selection-rest-api.md, index/, index/deep.ts, myconfig.ts
- **Note:** 8 files. "n" matches many — client (n in client), config (n in config), etc.

### @p
- **TUI:** (empty)
- **Note:** 0 files! "p" doesn't match anything despite "caps" containing "p" and "api" containing "p". This suggests polytoken does NOT do arbitrary subsequence matching — it requires boundary matches.

### @v
- **TUI:** caps/Server.rs, docs/server-selection-rest-api.md, server.rs, src/server/, src/server/lookup.rs
- **Note:** 5 files. "v" matches server (v in server), Server, etc. All have "v" in "server/Server".

### @x
- **TUI:** client/index.ts, index/, index/deep.ts, src/index.ts
- **Note:** 4 files. "x" matches index (x in index). All have "x" in "index".

### @z
- **TUI:** (empty)
- **Note:** 0 files. No "z" anywhere.

### @rs
- **TUI:** caps/Server.rs, server.rs, src/selection.rs, src/server/lookup.rs, docs/server-selection-rest-api.md
- **Note:** 5 files. "rs" matches: Server.rs (rs at end), server.rs (rs at end), selection.rs (rs at end), lookup.rs (rs at end), server-selection-rest-api.md (rs in "server"? s-e-r-v-e-r → no "rs" adjacent. But "Server" → S-e-r-v-e-r → "er" not "rs". Hmm, maybe fuzzy: r-s → r in "server", s in "selection"? No, ordered. Actually "Server.rs" → r at pos 4, s at pos 6 → "rs" subsequence. Yes, fuzzy.)

### @sel
- **TUI:** src/selection.rs, docs/server-selection-rest-api.md, src/server/lookup.rs
- **Note:** 3 files. "sel" matches selection (prefix), server-selection (segment prefix), and lookup.rs (fuzzy? s-e-l in "lookup"? l-o-o-k-u-p → no "sel". Maybe "src/server/lookup.rs" → s(0)e(?)l(?) — s at 0, e in "server"? s-e-r-v-e-r → e at 1. l? after pos 1: r-v-e-r-/-l-o-o-k-u-p → l at 7. So s(0)e(1)l(7) subsequence. Yes, fuzzy.)

### @ver
- **TUI:** caps/Server.rs, docs/server-selection-rest-api.md, server.rs, src/server/, src/server/lookup.rs
- **Note:** 5 files. "ver" matches Server (ver in Server), server, etc.

### @lec
- **TUI:** docs/server-selection-rest-api.md, src/selection.rs
- **Note:** 2 files. "lec" matches selection (lec in selection), server-selection-rest-api (lec in selection).

### @tion
- **TUI:** configuration.ts, docs/server-selection-rest-api.md, src/selection.rs
- **Note:** 3 files. "tion" matches configuration (tion at end), selection (tion in selection), server-selection-rest-api (tion in selection).

---

## Key algorithm observations (synthesis)

1. **Matching is fuzzy subsequence** — but with a twist: single chars like `@p` return nothing despite "p" existing in "caps" and "api". This suggests the fuzzy matcher requires matches at **word boundaries** (start of path, start of segment after `/`, or after separators like `-`, `_`, `.`, or camelCase transitions).

2. **`@p` returns 0** is the strongest evidence: "p" exists in "caps" (pos 2), "api" (pos 1), but neither is at a boundary start. Meanwhile `@v` returns 5 files — "v" appears in "server" at pos 3 (not at a boundary either). This contradicts the boundary theory.

   **Alternative:** maybe `@p` returns 0 because the fuzzy matcher has a **minimum score threshold** and single-char matches in the middle of words score too low. "v" in "server" might score higher because... unclear.

3. **The algorithm is NOT simple to reverse-engineer from captures alone.** The `@p` vs `@v` discrepancy (both are interior chars) suggests a scoring function with subtle position/penalty logic that we can't fully determine without source code.

4. **Pragmatic approach:** implement a fuzzy subsequence matcher with boundary-aware scoring (bonus for matches at segment starts, after separators, and at path start). This will get close to polytoken's behavior for most queries. Accept that exact match for every edge case (like `@p` returning 0) may not be achievable.

---

## Summary of disagreements

### 1. Matching algorithm: fuzzy vs substring
**The biggest difference.** Polytoken does fuzzy character matching (fzf-style); pantoken does substring matching.
- `@srselrs` → TUI: 3 matches; PAN: 0 matches
- `@servre` → TUI: 1 match; PAN: 0 matches
- `@test` → TUI includes docs/server-selection-rest-api.md; PAN doesn't
- `@ca`, `@cap`, `@co`, `@con`, `@ind` → TUI includes extra fuzzy matches

### 2. Inclusion: single-char / short queries
For short queries (1-2 chars), polytoken shows FEWER files than pantoken.
- `@s` → TUI: 6 files; PAN: 17 files
- `@c` → TUI: 6 files; PAN: 14 files
- `@i` → TUI: 5 files; PAN: 12 files
- `@d` → TUI: 5 files; PAN: 7 files
- `@t` → TUI: 7 files; PAN: 11 files

Polytoken appears to require the query to match at a word/segment boundary (start of path or start of a path segment), not just anywhere as a substring. Pantoken matches any substring.

### 3. Ordering: basename-prefix vs path-prefix priority
When both basename-prefix and path-prefix matches exist, the two rank differently:
- `@server` → TUI: server.rs first (basename-prefix); PAN: src/server/ first (path-prefix)
- `@src` → TUI: src/index.ts before src/server/; PAN: src/server/ before src/index.ts

### 4. Trailing-slash query
- `@index/` → TUI: includes the directory `index/` itself; PAN: doesn't (substring "index/" doesn't match path "index")

### 5. Tie-breaking within same match type
- `@index` → TUI: index/deep.ts before client/index.ts and src/index.ts; PAN: src/index.ts before client/index.ts before index/deep.ts
- `@config` (include_ignored) → TUI: src/.config.json before myconfig.ts; PAN: myconfig.ts before src/.config.json

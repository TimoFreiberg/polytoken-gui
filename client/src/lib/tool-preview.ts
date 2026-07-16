/**
 * Collapsed-header preview text for tool cards.
 *
 * The header `.arg` span shows a short, tool-specific summary instead of a raw
 * JSON dump. Each tool name maps to the field(s) most relevant for a quick
 * glance — e.g. `todo_create` shows its title, `web_search` shows the first
 * result's title from the output. All values are stringified with `String()`
 * so strings render without JSON quotes and numbers render as-is; null/undefined
 * fields are skipped.
 *
 * This module is pure view-model logic (no Svelte, no DOM), mirroring
 * `transcript-view.ts`. The default fallback reimplements ToolCard.svelte's
 * `preview()` locally so there's no circular import back into the component;
 * the duplication is a trivial, bounded copy of the `command`/`path`/
 * `file_path`/`stringify` heuristic.
 */
import { toolOutputText } from "./transcript-view.js";

const HEADER_PREVIEW_LIMIT = 320;

/** Truncate to `limit` chars with a trailing ellipsis (no newline marker). */
function inlineBound(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable value]";
  }
}

/** The existing default preview: prefer command/path/file_path, else JSON. */
function defaultPreview(input: unknown): string {
  if (input == null) return "";
  let text: string;
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") text = o.command;
    else if (typeof o.path === "string") text = o.path;
    else if (typeof o.file_path === "string") text = o.file_path;
    else text = stringify(input);
  } else {
    text = String(input);
  }
  return inlineBound(text, HEADER_PREVIEW_LIMIT);
}

/**
 * Stringify a single field from an object. Returns `null` when the key is
 * absent or the value is null/undefined (so callers can skip it rather than
 * render the literal string `"null"`).
 */
function strField(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  return String(v);
}

/** Join non-null parts with spaces; returns `""` if all parts are null. */
function joinFields(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join(" ");
}

/**
 * Extract the `terminal_reason` text from a `block_goal` tool input.
 *
 * The tool input schema defines `terminal_reason` as a plain string, but the
 * daemon's goal-state `TerminalReason` type is a struct `{kind, detail?}`.
 * Be defensive against both shapes: a string is used directly; an object
 * prefers `.detail` (more descriptive) then falls back to `.kind`.
 */
function terminalReasonText(o: Record<string, unknown>): string {
  const v = o.terminal_reason;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    if (typeof obj.kind === "string") return obj.kind;
  }
  return "";
}

/**
 * Extract the first result's title from a `web_search` tool output.
 *
 * The server's `extract_tool_result` always flattens daemon content into a
 * plain `serde_json::Value::String`, so the primary/production shape is a
 * plain string that itself contains a JSON array. Handles three shapes in
 * priority order:
 *
 * 1. Plain string (production): `JSON.parse` → array of objects with `.title`.
 * 2. Raw array (defensive): access first element's `.title` directly.
 * 3. Content-wrapped object (defensive/forward-compatible): lift text via
 *    `toolOutputText()` then `JSON.parse`.
 *
 * Returns `"first title"` for a single result, `"first title, …"` when there
 * are multiple. Returns `null` on any parse failure or unexpected shape so the
 * caller falls back to the `.query` from the input.
 */
export function webSearchResultTitle(output: unknown): string | null {
  let arr: unknown = null;

  if (typeof output === "string") {
    try {
      arr = JSON.parse(output);
    } catch {
      return null;
    }
  } else if (Array.isArray(output)) {
    arr = output;
  } else if (output && typeof output === "object") {
    // Content-wrapped object — lift the text, then parse.
    const text = toolOutputText(output);
    if (!text) return null;
    try {
      arr = JSON.parse(text);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0];
  if (!first || typeof first !== "object") return null;
  const title = (first as Record<string, unknown>).title;
  if (typeof title !== "string") return null;
  return arr.length > 1 ? `${title}, …` : title;
}

/**
 * Build the collapsed-header `.arg` preview for a tool card.
 *
 * Dispatches by tool name to pick the most relevant field(s). For `web_search`
 * the preview comes from the tool *output* (first result title) rather than the
 * input; while running (no output yet) it falls back to `.query`.
 *
 * Unknown/unlisted tools fall through to the existing default behavior
 * (`command`/`path`/`file_path`/`stringify`).
 */
export function toolPreview(
  name: string,
  input: unknown,
  output: unknown,
): string {
  if (input == null && name !== "web_search") return "";
  // `typeof null === "object"` in JS, so guard explicitly.
  const o =
    input != null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  switch (name) {
    case "write_plan":
    case "edit_plan":
    case "handoff_plan":
    case "popd":
      return "";

    case "web_search": {
      const title = webSearchResultTitle(output);
      if (title) return inlineBound(title, HEADER_PREVIEW_LIMIT);
      // Fall back to query while the tool is still running (no output yet)
      const query = strField(o, "query");
      return query ? inlineBound(query, HEADER_PREVIEW_LIMIT) : "";
    }

    case "block_goal":
      return inlineBound(terminalReasonText(o), HEADER_PREVIEW_LIMIT);

    case "todo_create":
      return inlineBound(strField(o, "title") ?? "", HEADER_PREVIEW_LIMIT);

    case "todo_list":
      return inlineBound(
        strField(o, "status_filter") ?? "",
        HEADER_PREVIEW_LIMIT,
      );

    case "todo_update":
      return inlineBound(
        joinFields(strField(o, "id"), strField(o, "title")),
        HEADER_PREVIEW_LIMIT,
      );

    case "todo_complete":
      return inlineBound(strField(o, "id") ?? "", HEADER_PREVIEW_LIMIT);

    case "subagent":
      return inlineBound(
        joinFields(
          strField(o, "name"),
          strField(o, "subagent_type"),
          strField(o, "model_override"),
        ),
        HEADER_PREVIEW_LIMIT,
      );

    case "skill":
      return inlineBound(strField(o, "name") ?? "", HEADER_PREVIEW_LIMIT);

    case "job_status":
    case "job_block":
      return inlineBound(strField(o, "job_id") ?? "", HEADER_PREVIEW_LIMIT);

    case "propose_goal":
      return inlineBound(strField(o, "summary") ?? "", HEADER_PREVIEW_LIMIT);

    default:
      return defaultPreview(input);
  }
}

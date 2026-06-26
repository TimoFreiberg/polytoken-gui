// Parser for the "tasklist" ambient widget.
//
// The tasklist pi extension (pilot/extensions/tasklist.ts, pilot-owned) pushes its state
// to the host as a plain `string[]` via ui.setWidget("tasklist", lines) — the only
// channel pilot's bridge renders remotely. [OPEN B]: the item lines carry just the
// description now (the `#id` is internal-only — the operator resolves tasks by
// description fragment via `findTask`, never by reading an id off the widget). The lines
// look like:
//
//   Open Tasks (3):
//     ○ first item
//     ○ item numero dos
//
// We don't control the wire shapes upstream of us in general, but for the pilot-owned
// tasklist we do — the extension is in-repo. Detection that "this is a tasklist" is done
// by the widget KEY upstream; this parser only extracts items and returns null when
// nothing parses, so a format drift degrades to the raw monospace box rather than an
// empty pill.

export interface ParsedTask {
  description: string;
}

// `  ○ description` — tolerate the open-circle glyph plus a couple of ASCII stand-ins
// and any leading whitespace. No id capture ([OPEN B]): the `#id` lives only in the
// extension's internal state + the agent-facing tool results, never in the widget line.
const ITEM = /^\s*[○◯o*-]\s*(.*)$/u;

/**
 * Parse the tasklist widget's lines into structured tasks. Returns null when no item
 * line matches (empty list, or a format we don't recognize) so callers can fall back to
 * rendering the raw lines.
 */
export function parseTasklist(
  lines: readonly string[] | undefined,
): ParsedTask[] | null {
  if (!lines || lines.length === 0) return null;
  const tasks: ParsedTask[] = [];
  for (const line of lines) {
    const m = ITEM.exec(line);
    const description = m?.[1];
    if (description !== undefined) {
      const trimmed = description.trim();
      if (trimmed.length > 0) tasks.push({ description: trimmed });
    }
  }
  return tasks.length > 0 ? tasks : null;
}

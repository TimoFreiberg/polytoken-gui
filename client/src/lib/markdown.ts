// Minimal, escape-first markdown -> HTML. Deliberately tiny and safe: everything
// is HTML-escaped before any transform, so agent/tool text can never inject markup.
// Covers fenced code, inline code, bold/italic, links, and paragraphs — enough for
// a Claude-like transcript. Swap for marked + DOMPurify later if we need full md.

const SENTINEL = String.fromCharCode(0); // never appears in real text

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // pull inline code out first so its contents aren't further transformed
  const codeSpans: string[] = [];
  let out = s.replace(/`([^`]+)`/g, (_m, c) => {
    codeSpans.push(`<code>${c}</code>`);
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
  out = out.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_m, i) => codeSpans[Number(i)] ?? "",
  );
  return out;
}

export function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  const parts: string[] = [];
  const segments = escaped.split(/```/);

  segments.forEach((seg, i) => {
    if (i % 2 === 1) {
      // fenced code block: optional language on first line
      const nl = seg.indexOf("\n");
      const lang = nl > 0 ? seg.slice(0, nl).trim() : "";
      const code = nl > 0 ? seg.slice(nl + 1) : seg;
      const langAttr = lang ? ` data-lang="${lang}"` : "";
      parts.push(
        `<pre${langAttr}><code>${code.replace(/\n$/, "")}</code></pre>`,
      );
      return;
    }
    // prose: paragraphs on blank lines, single newlines -> <br>
    for (const para of seg.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      parts.push(`<p>${inline(trimmed).replace(/\n/g, "<br>")}</p>`);
    }
  });

  return parts.join("");
}

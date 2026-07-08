<script lang="ts">
  // Single place that owns how agent/tool markdown is rendered (markstream-svelte).
  // The transcript renders agent/tool markdown through here.
  import MarkdownRender from "markstream-svelte";
  import { isDark } from "../lib/dark.svelte.js";
  import { copyCodeButtons } from "../lib/copy-code.js";

  // `fade` lights up markstream's per-block reveal animation (the `.fade-node` /
  // `.typewriter-node` wrappers, styled in markstream-theme.css). Default OFF: only the
  // live-streaming turn should animate — history, settled turns, session switches and
  // scroll-in must render statically, or the whole transcript would fade on every mount.
  let {
    content,
    final = true,
    fade = false,
  }: { content: string; final?: boolean; fade?: boolean } = $props();
</script>

<!-- Render config:
     - htmlPolicy "safe": allowlisted HTML only; scripts/event-handlers/style dropped,
       js:/data:/vbscript: links blocked, target=_blank hardened with rel=noopener.
     - customMarkdownIt disables typographer so quotes/dashes render verbatim — don't
       smart-quote technical text (markstream defaults it on). `md` is contextually typed.
     - renderCodeBlocksAsPre: plain <pre> code blocks (no Monaco peer, themed in app.css).
     - showTooltips=false: markstream's own link tooltip (singletonTooltip / `.ms-tooltip`)
       is styled ENTIRELY by its base dist/index.css, which we deliberately don't import
       (we theme via markstream-theme.css instead). Without that CSS the singleton has no
       `opacity:0`/`[data-visible]` binding and no `pointer-events:none`, so it renders as
       unstyled plain text that NEVER hides (hideTooltip only flips data-visible) and, sitting
       at z-index 9999, eats clicks on links beneath it. Turning it off makes LinkNode emit a
       plain `title={href}` instead, which pantoken's single delegated Tooltip.svelte renders —
       one themed tooltip system, hides correctly, pointer-events:none. -->
<!-- The wrapper hosts the copy-code action: it decorates each rendered code block with a
     pinned "copy" button (markstream owns the <pre>, so we enhance the DOM post-render).
     `.md-host` is the real direct child of the transcript's `.row.assistant`; the wide-row
     break-out CSS there targets this class to make the markdown body fill the row (Transcript.svelte). -->
<div class="md-host" use:copyCodeButtons>
  <MarkdownRender
    {content}
    {final}
    htmlPolicy="safe"
    customMarkdownIt={(md) => md.set({ typographer: false })}
    renderCodeBlocksAsPre
    showTooltips={false}
    {fade}
    isDark={isDark()}
  />
</div>

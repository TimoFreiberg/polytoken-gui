/**
 * SPIKE — throwaway, not a real pilot extension.
 *
 * Exists only to de-risk Chunk 0 of docs/PLAN-self-contained-extensions.md: prove
 * a pilot-bundled `.ts` extension loads via pi's `DefaultResourceLoaderOptions.
 * additionalExtensionPaths` and surfaces a `/pilot-spike` command. Delete after the
 * mechanism is validated (the real extensions — answer, tasklist, session-namer —
 * land in later chunks).
 *
 * Registered the same way every other extension is (see ~/.pi/agent/extensions/
 * thinking-preset.ts): an `ExtensionFactory` default export that receives the pi
 * API and calls `registerCommand`. The handler is a deliberate no-op — the point is
 * the command existing in the typeahead, not what it does.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI): void {
  _pi.registerCommand("pilot-spike", {
    description: "pilot chunk-0 spike (no-op)",
    handler: async () => {
      // Intentionally empty. The spike only needs to *register* the command so it
      // appears in the composer typeahead and in getExtensions() — exercising the
      // handler would require a running pi session, which the mock driver can't do.
    },
  });
}

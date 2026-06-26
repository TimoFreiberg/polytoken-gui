/** @pilot
 * name: Session auto-namer
 * description: Auto-names a session from its first prompt via the background model.
 */
/**
 * Session auto-namer (pilot-owned port of ~/dotfiles/agents/extensions/session-namer.ts).
 *
 * On the first user prompt of an as-yet-unnamed session, asks the background model for a
 * short, distinguishing name and sets it with pi.setSessionName(). Names show up in the
 * session selector instead of the raw first message.
 *
 * Fire-and-forget: the agent starts replying with zero added latency; the name lands a
 * moment later once the (cheap) model returns.
 *
 * PORTING NOTE (docs/PLAN-self-contained-extensions.md, Chunk 2): the dotfiles version
 * resolved its model via `_lib/roles.mjs`'s `resolveRoleModel("text-summary", …)`,
 * reached through a realpath-cross-symlink dynamic import. That whole dance is gone —
 * this is a local file now. The model comes from pilot's `backgroundModel` setting
 * (D2), threaded into the session as the `background-model` extension flag in
 * pi-driver `warmUp` (Chunk 1). Here we `registerFlag` + read it via
 * `pi.getFlag("background-model")` and resolve the spec string against
 * `ctx.modelRegistry` (public pi API only — `getAvailable()`/`find()`), the same
 * contract the server's `resolveBackgroundModel` validates against. Unset → no-op (the
 * dotfiles version's role-unresolved path is the analogue), never crashes.
 *
 * Only fires when ALL of these hold:
 *  - the session has no explicit name yet  -> never overrides a manual name
 *  - the input is a real idle prompt        -> not a mid-stream steer / followup
 *  - source is not extension-injected     -> interactive / rpc / etc. all pass; another
 *                                            extension's injected input does not
 *  - we're in a UI mode (hasUI)             -> skips one-shot `-p` / json runs
 * An in-flight guard stops a quick second prompt from launching a parallel name.
 *
 * Degrades gracefully, per the "fail loud but don't corrupt downstream" philosophy: any
 * failure (spec unset, no auth, model/network error, empty result) emits a quiet warning
 * and leaves the session unnamed. Naming a session is a convenience — it must never
 * block or crash the turn.
 */

// `Api` (the model-api union) + `Model` + `UserMessage` live on `@earendil-works/pi-ai`.
// pi-coding-agent re-exports `Model`/`UserMessage` but NOT `Api` — importing it from there
// is a type-resolution error the un-typechecked extensions tree was hiding (same shape as
// the ctx.getFlag bug). Pull `Api` from its real home alongside `Model`.
import {
  complete,
  type Api,
  type Model,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// The flag pilot threads (Chunk 1 warmUp): its value is a PLAIN `provider/model[:thinking]`
// spec string — the one `resolveBackgroundModel` resolved the `backgroundModel` setting
// (which may itself be `script:`-prefixed) to SERVER-SIDE in warmUp (C1). We only read it;
// the `script:` path is resolved server-side and the resolved spec is what's threaded, so
// here it's always a plain spec (or unset, when the setting is null or didn't resolve).
// Registered so `getFlag` can read it.
const BACKGROUND_MODEL_FLAG = "background-model";

// Hard cap. ~25 is the readable sweet spot; the prompt asks the model to aim there, and
// sanitizeName() enforces the ceiling regardless of what comes back.
const MAX_LEN = 40;

// pi's thinking-level ladder (incl. `off`). Mirrors pi's `ThinkingLevel`/`VALID_THINKING_LEVELS`
// — a spec's `:thinking` suffix must be one of these or it's dropped (non-fatal).
const VALID_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const SYSTEM_PROMPT = [
  "You generate a short title for a coding session, from the user's first message.",
  "Rules:",
  "- Output ONLY the title. No quotes, no trailing punctuation, no preamble.",
  "- Capture the specific task or topic so the session is easy to tell apart from",
  "  others in a list. Use concrete words from the request; avoid generic filler",
  '  like "help", "task", or "session".',
  "- Under 40 characters; aim for about 25. A short phrase, not a sentence.",
  "Examples: Fix auth redirect loop / Add dark-mode toggle / Debug flaky CI test",
].join("\n");

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** A minimal slice of the model fields we read. Opaque otherwise — handed straight to
 *  pi's stream API. */
interface ResolvedModel {
  model: Model<Api>;
  /** pi thinking level when a `:thinking` suffix was parsed, else undefined. */
  thinkingLevel?: string;
}

/** Try an exact `provider/modelId` (or bare-id) match against available models BEFORE the
 *  colon-split. Mirrors the server's `findExactModelReferenceMatch` (background-model.ts):
 *  a canonical `provider/id` exact match (case-insensitive); a bare-id match only when
 *  unambiguous across providers. Returns undefined when nothing matches or it's ambiguous
 *  — the caller falls through to the colon-split + `find()` path. */
function tryExactMatch(
  reference: string,
  available: readonly Model<Api>[],
): Model<Api> | undefined {
  const lower = reference.trim().toLowerCase();
  if (!lower) return undefined;
  // Canonical `provider/id` exact match first.
  const canonical = available.filter(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === lower,
  );
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined; // ambiguous
  // Bare-id exact match (rejected when ambiguous across providers).
  const byId = available.filter((m) => m.id.toLowerCase() === lower);
  return byId.length === 1 ? byId[0] : undefined;
}

/**
 * Resolve a `provider/model[:thinking]` spec against the registry, inline (the server's
 * `resolveBackgroundModel` validates the SAME spec for Settings — parity matters so a
 * spec that validates also runs). Public pi API only: `getAvailable()` + `find()`.
 *
 * - `provider/modelId` exact (via `find`), optionally with a trailing `:thinking`.
 * - Bare `modelId` matches against `getAvailable()` (rejected when ambiguous across
 *   providers, so a bare id two providers ship resolves to nothing — matches the server).
 * - An invalid `:thinking` suffix is dropped with a non-fatal warning surface (the
 *   caller's note channel); a valid one is honoured on the stream call.
 *
 * Returns `null` when the spec doesn't resolve (caller no-ops). Does NOT handle the
 * `script:` prefix — pilot resolves those server-side and threads the plain spec.
 */
function resolveSpec(
  spec: string,
  registry: ExtensionContext["modelRegistry"],
  note: (msg: string) => void,
): ResolvedModel | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  // Split off a trailing `:thinking` (after any provider slash) — mirrors the server's
  // last-colon split so a model id that itself contains a colon still needs a slash.
  let thinkingLevel: string | undefined;
  let core = trimmed;
  const colon = trimmed.lastIndexOf(":");
  const slash = trimmed.indexOf("/");
  if (colon !== -1 && colon > slash) {
    const suffix = trimmed.slice(colon + 1);
    const prefix = trimmed.slice(0, colon);
    if (
      VALID_THINKING_LEVELS.includes(
        suffix as (typeof VALID_THINKING_LEVELS)[number],
      )
    ) {
      thinkingLevel = suffix === "off" ? undefined : suffix;
      core = prefix;
    } else {
      // Invalid thinking level: try the prefix; if it resolves, drop the level + warn
      // (non-fatal — matches pi's scope-warn path the server mirrors). If not, fall
      // through to the not-found warning below.
      core = prefix;
    }
  }

  const available = registry.getAvailable();

  // EXACT-MATCH FIRST (parity with the server's `parseSpec`/`tryMatchModel`): try the
  // full `spec` (incl. any colons in the model id, e.g. OpenRouter's `:exacto`/`:nitro`
  // variants) against available models BEFORE the colon-split below. Without this, a
  // colon-bearing model id with NO `:thinking` suffix would be mis-split: `openrouter/
  // some-model:exacto` → suffix `exacto` (invalid thinking) → prefix `some-model` →
  // `registry.find("openrouter","some-model")` misses the real id. The server resolves
  // such specs cleanly via this same exact-first step; matching it keeps Settings-
  // validation and runtime in parity (the D2 "a spec that validates also runs" promise).
  // The colon-split below still handles a real `:thinking` suffix on a colon-bearing id.
  let model: Model<Api> | undefined = tryExactMatch(trimmed, available);
  if (model) {
    // Exact match on the FULL spec (incl. any colons in the id) means there was no
    // `:thinking` suffix to honour — the colon-split above may have set one for a
    // model id that literally ends in a level token (e.g. `some-model:low`). Drop it
    // to match the server's `return { model: exact }` (no thinking level) and keep
    // Settings-vs-runtime parity.
    thinkingLevel = undefined;
  } else {
    const providerSlash = core.indexOf("/");
    if (providerSlash !== -1) {
      const provider = core.slice(0, providerSlash).trim();
      const modelId = core.slice(providerSlash + 1).trim();
      if (provider && modelId) model = registry.find(provider, modelId);
    } else {
      // Bare id: match against available models; reject when ambiguous across providers.
      const lower = core.toLowerCase();
      const matches = available.filter((m) => m.id.toLowerCase() === lower);
      model = matches.length === 1 ? matches[0] : undefined;
    }
  }

  if (!model) {
    note(
      `session-namer: background-model "${trimmed}" did not resolve to a registered model`,
    );
    return null;
  }

  // Only honour a thinking level when the model actually supports reasoning.
  if (thinkingLevel && !(model as { reasoning?: unknown }).reasoning) {
    thinkingLevel = undefined;
  }
  return { model, thinkingLevel };
}

/**
 * Clean up whatever the model returns into a tidy <=MAX_LEN label: first line only, strip
 * wrapping quotes and any "Title:"-style prefix, collapse whitespace, then truncate on a
 * word boundary when one is close to the cap.
 */
function sanitizeName(raw: string): string {
  let name = (raw.split("\n")[0] ?? "").trim();
  name = name.replace(/^["'`]+|["'`]+$/g, "").trim();
  name = name
    .replace(/^(session\s*name|title|name|session)\s*[:\-]\s*/i, "")
    .trim();
  name = name.replace(/\s+/g, " ");

  if (name.length > MAX_LEN) {
    name = name.slice(0, MAX_LEN);
    const lastSpace = name.lastIndexOf(" ");
    if (lastSpace >= MAX_LEN - 12) name = name.slice(0, lastSpace);
    name = name.replace(/[\s\-–—:;,.]+$/, "").trim();
  }
  return name;
}

/**
 * Read the spec, resolve the model, authenticate, ask for a name, set it. Every failure
 * path returns quietly (warning notify only) without throwing — callers run this
 * fire-and-forget.
 */
async function nameSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): Promise<void> {
  const note = (msg: string) => {
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
  };

  // `getFlag` lives on the ExtensionAPI (pi), not the per-event ExtensionContext —
  // `ctx.getFlag` is undefined at runtime and would crash (the pilot/extensions tree
  // isn't in any tsconfig project, so tsc never caught the type error).
  const spec = pi.getFlag(BACKGROUND_MODEL_FLAG);
  if (typeof spec !== "string" || !spec.trim()) {
    // Unset → no-op, the dotfiles version's "role resolved to no model" analogue.
    // Naming is a convenience; an unconfigured background model is not an error to
    // shout about on every prompt. (Set the background model in Settings → Models.)
    return;
  }

  const resolved = resolveSpec(spec, ctx.modelRegistry, note);
  if (!resolved) return;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved.model);
  if (!auth.ok) {
    note(`session-namer: no auth for ${spec} (${auth.error})`);
    return;
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };

  let response: Awaited<ReturnType<typeof complete>>;
  try {
    response = await complete(
      resolved.model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        ...(resolved.thinkingLevel
          ? { reasoning: resolved.thinkingLevel }
          : {}),
      },
    );
  } catch (err) {
    note(`session-namer: naming call failed (${errText(err)})`);
    return;
  }

  if (response.stopReason === "aborted" || response.stopReason === "error") {
    return;
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ");

  const name = sanitizeName(text);
  if (!name) {
    note("session-namer: model returned an empty name");
    return;
  }

  // A manual name (or another extension) may have landed while we were out on the model
  // call — don't clobber it.
  if (pi.getSessionName()) return;

  pi.setSessionName(name);
  if (ctx.hasUI) ctx.ui.notify(`Session named: ${name}`, "info");
}

export default function (pi: ExtensionAPI) {
  // Register the background-model flag so `getFlag` can read it. Pilot threads the
  // value in warmUp; we only consume it here. `type:"string"` matches how pi threads it.
  pi.registerFlag(BACKGROUND_MODEL_FLAG, {
    description:
      "Pilot's background model spec (provider/model[:thinking]) for cheap out-of-band calls",
    type: "string",
  });

  // Guards a single naming attempt at a time. If the attempt fails the session stays
  // unnamed, so the next prompt retries; once it succeeds, the getSessionName() check
  // below short-circuits all future prompts.
  let inFlight = false;

  pi.on("input", async (event, ctx) => {
    if (
      inFlight ||
      event.source === "extension" || // injected by another extension
      event.streamingBehavior !== undefined || // mid-stream steer / queued followup
      !ctx.hasUI || // one-shot -p / json run: no selector to benefit
      pi.getSessionName() // already named (manual or a prior auto-name)
    ) {
      return { action: "continue" };
    }

    const prompt = event.text.trim();
    if (!prompt) return { action: "continue" };

    inFlight = true;
    // Fire-and-forget: returning immediately keeps the agent's first token un-delayed by
    // the naming round-trip.
    void nameSession(pi, ctx, prompt).finally(() => {
      inFlight = false;
    });

    return { action: "continue" };
  });
}

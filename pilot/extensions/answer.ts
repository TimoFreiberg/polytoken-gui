/** @pilot
 * name: Answer (Q&A)
 * description: Interactive Q&A widget — the agent asks questions via a structured form, optionally extracting them from its last message.
 */
/**
 * Q&A extension (pilot-owned port of ~/dotfiles/agents/extensions/answer.ts) — two
 * paths into one interactive Q&A widget.
 *
 * 1. LLM-callable `answer` TOOL: the agent passes `questions[]` DIRECTLY,
 *    each optionally carrying `options` (a selectable choice list) and a
 *    `multiSelect` flag. No extraction model on this path.
 * 2. `/answer` command (or Ctrl+.): grabs the last assistant message, EXTRACTS
 *    free-text questions from it via the background model, then opens the same
 *    widget. The command path produces free-text questions only (no options).
 *
 * The widget (QnAComponent) renders, per question, either:
 *   - a free-text editor (no `options`), or
 *   - a selectable choice list — checkboxes when `multiSelect`, single-select
 *     otherwise — plus a "Type something" free-text escape.
 *
 * The full Q&A (question + options + chosen/typed answers) is persisted to the
 * transcript: the tool returns it as text `content`, the command path sends it
 * via `pi.sendUserMessage(...)`. Questions used to die inside the transient
 * widget; recording them in the transcript is the core fix.
 *
 * PORTING NOTE (docs/PLAN-self-contained-extensions.md, Chunk 4): the dotfiles
 * version resolved its extraction model via `_lib/roles.mjs`'s
 * `resolveRoleModel("structured-extraction", …)`, reached through a
 * realpath-cross-symlink dynamic import. That whole dance is gone — this is a
 * local file now. The extraction model comes from pilot's `backgroundModel`
 * setting (D2), threaded into the session as the `background-model` extension
 * flag in pi-driver `warmUp` (Chunk 1); the extensions register + read it via
 * `pi.getFlag("background-model")` and resolve the spec string against
 * `ctx.modelRegistry` (public pi API only — `getAvailable()`/`find()`), the same
 * contract the server's `resolveBackgroundModel` validates against. Unset → the
 * extraction candidate list degrades to the provider-pattern scan + the session
 * model (the dotfiles role-unavailable path is the analogue), never crashes.
 *
 * THE qna SEAM (D2 tracked risk, docs/DECISIONS.md): the `ctx.mode !== "tui"`
 * branch below calls `ctx.ui.qna(...)` — a method that is NOT on pi's typed
 * `ExtensionUIContext`. It is only reachable because pi hands extensions the
 * RAW, UNWRAPPED `PiUiBridge` as `ctx.ui` (the `as unknown as
 * ExtensionUIContext` cast at pi-driver.ts bindExtensions). Pilot now owns BOTH
 * sides of this seam: the extension (this file) that calls `ctx.ui.qna`, AND the
 * `PiUiBridge` that implements it — so the coupling is INTENTIONAL, not
 * incidental. The canary `ui-bridge-coupling.test.ts` keeps it loud (compile-
 * time: `qna` stays off the typed interface; runtime: `PiUiBridge` exposes it).
 * Under pilot, `ctx.mode` is `"rpc"` (pi-driver.ts bindExtensions), so this
 * branch is the one that fires and the TUI `QnAComponent` path is inert.
 */

import {
  complete,
  type Model,
  type Api,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ModelRegistry,
  type SessionMessageEntry,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- Types ---

/** A selectable option offered by the LLM for a choice question. */
interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * A question shown in the widget. `options` is the discriminator between the
 * two render modes:
 *   - absent → free-text editor (the command/extraction path always uses this)
 *   - present → selectable choice list (single-select, or checkboxes when
 *     `multiSelect`). The tool path supplies these directly.
 */
export interface ExtractedQuestion {
  question: string;
  context?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface ExtractionResult {
  questions: ExtractedQuestion[];
}

/**
 * The per-question answer captured by the widget. Kept structured (rather than
 * a pre-formatted string) so the transcript formatter can record the question,
 * its options, and exactly which were picked vs. freely typed.
 */
export interface QnAAnswer {
  /** Indices into `question.options` the user selected (choice questions). */
  selectedOptionIndices: number[];
  /**
   * Free text the user typed: the whole answer for free-text questions, or the
   * "Type something" escape value for choice questions. Empty when unused.
   */
  customText: string;
}

export function emptyAnswer(): QnAAnswer {
  return { selectedOptionIndices: [], customText: "" };
}

// --- Transcript formatting (pure, unit-tested) ---

/**
 * Format a Q&A session into the transcript text shared by both entry paths.
 * Pure and deterministic so it can be unit-tested without a TUI.
 *
 * Output shape per question:
 *   Q: <question>
 *   > <context>                (only if present)
 *   Options:                   (only for choice questions)
 *     [x] <picked label>
 *     [ ] <unpicked label>
 *   A: <answer>
 *
 * The `A:` line records the human-readable answer: the picked option label(s)
 * for choice questions, the typed text for free-text / "Type something", or
 * "(no answer)" when nothing was provided.
 */
export function formatQnA(
  questions: ExtractedQuestion[],
  answers: QnAAnswer[],
): string {
  const parts: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    // The loop bound guarantees i < questions.length, so q is defined; the guard
    // satisfies noUncheckedIndexedAccess and skips a malformed (short) array
    // defensively rather than crashing the formatter.
    if (!q) continue;
    const a = answers[i] ?? emptyAnswer();

    parts.push(`Q: ${q.question}`);
    if (q.context) {
      parts.push(`> ${q.context}`);
    }

    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    if (hasOptions) {
      const picked = new Set(a.selectedOptionIndices);
      parts.push("Options:");
      const opts = q.options!;
      for (let j = 0; j < opts.length; j++) {
        const opt = opts[j];
        if (!opt) continue; // loop bound guarantees this; guard for noUncheckedIndexedAccess
        const mark = picked.has(j) ? "[x]" : "[ ]";
        parts.push(`  ${mark} ${opt.label}`);
      }
    }

    // Build the human-readable answer line.
    const chosenLabels = hasOptions
      ? a.selectedOptionIndices
          .filter((idx) => idx >= 0 && idx < q.options!.length)
          .map((idx) => q.options![idx])
          .filter((opt): opt is QuestionOption => Boolean(opt))
          .map((opt) => opt.label)
      : [];
    const custom = a.customText.trim();
    const answerSegments: string[] = [...chosenLabels];
    if (custom) {
      // Mark free text distinctly when it accompanies a choice question.
      answerSegments.push(hasOptions ? `(typed) ${custom}` : custom);
    }
    const answerText =
      answerSegments.length > 0 ? answerSegments.join(", ") : "(no answer)";
    parts.push(`A: ${answerText}`);
    parts.push("");
  }

  return parts.join("\n").trim();
}

// --- Prompts ---

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

// --- Model selection (background model from the D2 flag) ---

// The flag pilot threads (Chunk 1 warmUp): its value is a PLAIN `provider/model[:thinking]`
// spec string — the one `resolveBackgroundModel` resolved the `backgroundModel` setting
// (which may itself be `script:`-prefixed) to SERVER-SIDE in warmUp (C1). We only read it;
// the `script:` path is resolved server-side and the resolved spec is what's threaded, so
// here it's always a plain spec (or unset, when the setting is null or didn't resolve).
// Registered (in the entry point below) so `getFlag` can read it.
const BACKGROUND_MODEL_FLAG = "background-model";

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

/** Resolve a `provider/model[:thinking]` spec against the registry, inline (the server's
 *  `resolveBackgroundModel` validates the SAME spec for Settings — parity matters so a
 *  spec that validates also runs). Public pi API only: `getAvailable()` + `find()`.
 *
 *  - `provider/modelId` exact (via `find`), optionally with a trailing `:thinking`.
 *  - Bare `modelId` matches against `getAvailable()` (rejected when ambiguous across
 *    providers, so a bare id two providers ship resolves to nothing — matches the server).
 *  - A trailing `:thinking` suffix is STRIPPED (not applied — the extraction `complete()`
 *    call never passed one in the dotfiles version; the port preserves that).
 *
 *  Returns the resolved model, or `null` when the spec doesn't resolve (caller no-ops).
 *  Does NOT handle the `script:` prefix — pilot resolves those server-side and threads
 *  the plain spec. */
function resolveBackgroundModelSpec(
  spec: string,
  registry: ModelRegistry,
  note: (msg: string) => void,
): Model<Api> | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  // Split off a trailing `:thinking` (after any provider slash) — mirrors the server's
  // last-colon split so a model id that itself contains a colon still needs a slash. The
  // thinking level is NOT applied: the dotfiles answer.ts extraction `complete(...)` call
  // never passed one (the role resolver returned it and answer ignored it), and the port
  // preserves that. So we just strip any trailing `:suffix` for the lookup, whether or not
  // it's a valid level — a bogus suffix here only matters if the stripped prefix then
  // fails to resolve, in which case the not-found note below surfaces it.
  let core = trimmed;
  const colon = trimmed.lastIndexOf(":");
  const slash = trimmed.indexOf("/");
  if (colon !== -1 && colon > slash) {
    core = trimmed.slice(0, colon);
  }

  const available = registry.getAvailable();

  // EXACT-MATCH FIRST (parity with the server's `parseSpec`/`tryMatchModel`): try the
  // full `spec` (incl. any colons in the model id, e.g. OpenRouter's `:exacto`/`:nitro`
  // variants) against available models BEFORE the colon-split below. Without this, a
  // colon-bearing model id with NO `:thinking` suffix would be mis-split. The server
  // resolves such specs cleanly via this same exact-first step; matching it keeps
  // Settings-validation and runtime in parity (the D2 promise). (Inlined from session-namer.)
  let model: Model<Api> | undefined = tryExactMatch(trimmed, available);
  if (!model) {
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
      `answer: background-model "${trimmed}" did not resolve to a registered model`,
    );
    return null;
  }
  return model;
}

// Model patterns for extraction, in priority order. Sonnet 4.6 first
// (haiku makes too many mistakes on this task); we fall through to any
// available Sonnet, then the session model itself.
//
// Only models from the same provider as the session model are considered,
// so we reuse the same auth config that's already working.
//
// NOTE (Bedrock): prefer `global.` prefixed model IDs — those are the
// cross-region inference profiles that work for the current setup.
// Update this if the Bedrock config changes.
const EXTRACTION_MODEL_PATTERNS: (string | RegExp)[] = [
  /global\.anthropic\.claude-sonnet-4-6/, // Bedrock Sonnet 4.6 (global)
  /sonnet-4-6/, // Sonnet 4.6 (other providers)
  /global\.anthropic\.claude-sonnet/, // Bedrock Sonnet (any, fallback)
  /sonnet/, // Sonnet (other providers, fallback)
];

interface ModelCandidate {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
}

/** Build candidate models for extraction. Strategy (first hit wins; all are
 *  appended as ordered fallbacks so doExtract can retry the next on failure):
 *  1. The background-model flag (pilot's D2 setting, resolved inline). This is the
 *     primary path — it honors the operator's chosen background model.
 *  2. Cheaper models from the SAME provider as the session (reuses session auth).
 *  3. Always fall back to the session's own model (known to work).
 *
 *  The flag path degrades gracefully: if the spec is unset, doesn't resolve, or has
 *  no auth, we skip it (a note when it resolves-but-fails-auth) and fall through to
 *  the existing pattern scan + ctx.model. answer.ts must NEVER hard-fail just because
 *  the background model didn't resolve — matching the dotfiles role-unavailable path. */
async function getCandidateModels(
  currentModel: Model<Api>,
  modelRegistry: ModelRegistry,
  notify: (message: string) => void,
  backgroundModelSpec?: string,
): Promise<ModelCandidate[]> {
  const candidates: ModelCandidate[] = [];
  const seen = new Set<string>();
  const available = modelRegistry.getAvailable();

  const pushCandidate = async (model: Model<Api>): Promise<void> => {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false) return;
    candidates.push({ model, apiKey: auth.apiKey, headers: auth.headers });
    seen.add(key);
  };

  // 1. Background-model flag (pilot's D2 setting). Unset → no candidate here, fall
  //    through to the pattern scan + session model (the unset/role-unavailable path).
  //    Fail loud (a note), degrade gracefully: any failure falls through below.
  if (backgroundModelSpec) {
    try {
      const resolved = resolveBackgroundModelSpec(
        backgroundModelSpec,
        modelRegistry,
        notify,
      );
      if (resolved) {
        await pushCandidate(resolved);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(`answer: background-model unavailable (${message})`);
    }
  }

  // 2. Look for preferred models from the same provider
  for (const pattern of EXTRACTION_MODEL_PATTERNS) {
    const match = available.find(
      (m) =>
        m.provider === currentModel.provider &&
        (pattern instanceof RegExp
          ? pattern.test(m.id.toLowerCase())
          : m.id.toLowerCase().includes(pattern)),
    );
    if (match) {
      await pushCandidate(match);
    }
  }

  // 3. Always include the session model as the final (most reliable) fallback
  await pushCandidate(currentModel);

  return candidates;
}

// --- JSON parsing ---

function parseExtractionResult(text: string): ExtractionResult {
  let jsonStr = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    // The regex has exactly one capture group; it's defined when jsonMatch matches.
    // The non-null assertion is safe under noUncheckedIndexedAccess because the
    // `if (jsonMatch)` guard above confirms a match.
    jsonStr = jsonMatch[1]!.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const jsonError = e instanceof Error ? e.message : String(e);
    const preview =
      jsonStr.length > 200 ? jsonStr.slice(0, 200) + "..." : jsonStr;
    throw new Error(`Invalid JSON: ${jsonError}\nResponse preview: ${preview}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).questions)
  ) {
    const preview =
      jsonStr.length > 200 ? jsonStr.slice(0, 200) + "..." : jsonStr;
    throw new Error(
      `Response JSON missing "questions" array.\nParsed value: ${preview}`,
    );
  }

  return parsed as ExtractionResult;
}

// --- Theme helpers ---

function buildEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (s: string) => theme.fg("border", s),
    selectList: {
      selectedPrefix: (s: string) => theme.fg("accent", s),
      selectedText: (s: string) => theme.fg("accent", s),
      description: (s: string) => theme.fg("muted", s),
      scrollInfo: (s: string) => theme.fg("dim", s),
      noMatch: (s: string) => theme.fg("warning", s),
    },
  };
}

// --- Q&A Component ---

/**
 * Interactive Q&A widget. Per question it switches between two modes based on
 * whether the question carries `options`:
 *
 *   - free-text mode: a single Editor; the typed text is the answer.
 *   - choice mode: a vertical option list. `multiSelect` questions use
 *     checkboxes (Space toggles, Enter confirms the question); single-select
 *     questions confirm immediately on Enter. Both offer a trailing
 *     "Type something" escape that drops into the editor for a free-text answer.
 *
 * Navigation across questions is Tab / Shift+Tab. In choice mode, Up/Down move
 * the option cursor; in free-text mode, Up/Down navigate questions only when
 * the editor is empty (so arrows still work for cursor movement otherwise).
 */
class QnAComponent implements Component, Focusable {
  private questions: ExtractedQuestion[];
  private answers: QnAAnswer[];
  private currentIndex: number = 0;
  /** Cursor within the current choice question's option list. */
  private optionCursor: number = 0;
  /** True while the "Type something" editor is active on a choice question. */
  private choiceEditMode: boolean = false;
  private editor: Editor;
  private theme: Theme;
  private onDone: (result: string | null) => void;
  private requestRender: () => void;
  private showingConfirmation: boolean = false;
  private showingCancelConfirmation: boolean = false;
  private modelId?: string;
  private keybindings?: KeybindingsManager;
  private onToggleExpand?: () => void;

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  // Focusable: propagate to Editor child for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  constructor(
    questions: ExtractedQuestion[],
    tui: TUI,
    theme: Theme,
    onDone: (result: string | null) => void,
    requestRender: () => void,
    options?: {
      modelId?: string;
      keybindings?: KeybindingsManager;
      onToggleExpand?: () => void;
    },
  ) {
    this.questions = questions;
    this.answers = questions.map(() => emptyAnswer());
    this.theme = theme;
    this.onDone = onDone;
    this.requestRender = requestRender;
    this.modelId = options?.modelId;
    this.keybindings = options?.keybindings;
    this.onToggleExpand = options?.onToggleExpand;

    this.editor = new Editor(tui, buildEditorTheme(theme));
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.invalidate();
      this.requestRender();
    };

    // Restore editor text for the first question if it is free-text.
    this.syncEditorToCurrent();
  }

  // --- Mode helpers ---

  private currentQuestion(): ExtractedQuestion {
    // currentIndex is clamped to [0, questions.length) by navigateTo's bounds
    // guard; reaching here out of bounds is a logic bug we want to surface loudly,
    // not silently degrade. (noUncheckedIndexedAccess makes this.questions[i]
    // ExtractedQuestion | undefined — the guard also satisfies that.)
    const q = this.questions[this.currentIndex];
    if (!q)
      throw new Error(
        `answer: currentIndex ${this.currentIndex} out of range (questions: ${this.questions.length})`,
      );
    return q;
  }

  /** The answer for the current question. Mirrors currentQuestion(): in-bounds by
   *  construction (answers is built questions-length via emptyAnswer()), guarded
   *  so a future length-mismatch bug surfaces instead of corrupting silently. */
  private currentAnswer(): QnAAnswer {
    const a = this.answers[this.currentIndex];
    if (!a)
      throw new Error(
        `answer: currentIndex ${this.currentIndex} out of range (answers: ${this.answers.length})`,
      );
    return a;
  }

  /** Whether the current question is a choice question (has options). */
  private isChoice(index: number = this.currentIndex): boolean {
    const opts = this.questions[index]?.options;
    return Array.isArray(opts) && opts.length > 0;
  }

  /**
   * Option rows for the current choice question: the LLM-supplied options plus
   * a trailing "Type something" escape (index === options.length).
   */
  private choiceRowCount(): number {
    const q = this.currentQuestion();
    return (q.options?.length ?? 0) + 1; // +1 for the "Type something" row
  }

  private isOtherRow(rowIndex: number): boolean {
    return rowIndex === (this.currentQuestion().options?.length ?? 0);
  }

  /** Whether any answer (selection or typed text) has been recorded yet. */
  private isAnswered(index: number): boolean {
    const a = this.answers[index];
    if (!a) return false;
    return a.selectedOptionIndices.length > 0 || a.customText.trim().length > 0;
  }

  private hasAnyAnswers(): boolean {
    this.saveCurrentAnswer();
    return this.answers.some((_, i) => this.isAnswered(i));
  }

  /** Persist transient editor text into the current answer (free-text path). */
  private saveCurrentAnswer(): void {
    if (this.isChoice()) {
      // Choice selections are saved eagerly on toggle/select; only the
      // "Type something" escape uses the editor, and that is captured when the
      // user leaves edit mode. Nothing to flush here unless mid-edit.
      if (this.choiceEditMode) {
        this.currentAnswer().customText = this.editor.getText();
      }
      return;
    }
    this.currentAnswer().customText = this.editor.getText();
  }

  /** Load the current question's stored free-text into the editor, if any. */
  private syncEditorToCurrent(): void {
    if (this.isChoice() && !this.choiceEditMode) {
      this.editor.setText("");
      return;
    }
    this.editor.setText(this.currentAnswer().customText || "");
  }

  private navigateTo(index: number): void {
    if (index < 0 || index >= this.questions.length) return;
    this.saveCurrentAnswer();
    this.currentIndex = index;
    this.optionCursor = 0;
    this.choiceEditMode = false;
    this.syncEditorToCurrent();
    this.invalidate();
  }

  // --- Choice-mode actions ---

  /** Toggle (multiSelect) or set (single-select) the option under the cursor. */
  private chooseCurrentOption(): void {
    const q = this.currentQuestion();
    const a = this.currentAnswer();

    if (this.isOtherRow(this.optionCursor)) {
      // Enter the free-text escape editor.
      this.choiceEditMode = true;
      this.editor.setText(a.customText || "");
      this.invalidate();
      this.requestRender();
      return;
    }

    const idx = this.optionCursor;
    if (q.multiSelect) {
      const pos = a.selectedOptionIndices.indexOf(idx);
      if (pos >= 0) {
        a.selectedOptionIndices.splice(pos, 1);
      } else {
        a.selectedOptionIndices.push(idx);
        a.selectedOptionIndices.sort((x, y) => x - y);
      }
      // Selecting an option clears any prior free-text escape for clarity.
      this.invalidate();
      this.requestRender();
      return;
    }

    // Single-select: replace selection, drop any free text, advance/confirm.
    a.selectedOptionIndices = [idx];
    a.customText = "";
    this.advanceOrConfirm();
  }

  /** Advance to the next question, or show the submit confirmation on last. */
  private advanceOrConfirm(): void {
    if (this.currentIndex < this.questions.length - 1) {
      this.navigateTo(this.currentIndex + 1);
    } else {
      this.showingConfirmation = true;
      this.invalidate();
    }
    this.requestRender();
  }

  private submit(): void {
    this.saveCurrentAnswer();
    this.onDone(formatQnA(this.questions, this.answers));
  }

  private cancel(): void {
    this.onDone(null);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    // Expand/collapse tool output (Ctrl+O by default)
    if (
      this.keybindings?.matches(data, "app.tools.expand") &&
      this.onToggleExpand
    ) {
      this.onToggleExpand();
      return;
    }

    // Submit confirmation dialog
    if (this.showingConfirmation) {
      if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
        this.submit();
        return;
      }
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        data.toLowerCase() === "n"
      ) {
        this.showingConfirmation = false;
        this.invalidate();
        this.requestRender();
        return;
      }
      return;
    }

    // Cancel confirmation dialog
    if (this.showingCancelConfirmation) {
      if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
        this.cancel();
        return;
      }
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        data.toLowerCase() === "n"
      ) {
        this.showingCancelConfirmation = false;
        this.invalidate();
        this.requestRender();
        return;
      }
      return;
    }

    // --- Choice question, free-text escape ("Type something") active ---
    if (this.isChoice() && this.choiceEditMode) {
      // Esc leaves the escape editor and returns to the option list.
      if (matchesKey(data, Key.escape)) {
        this.currentAnswer().customText = this.editor.getText();
        this.choiceEditMode = false;
        this.invalidate();
        this.requestRender();
        return;
      }
      // Plain Enter commits the typed text and advances/confirms.
      if (
        matchesKey(data, Key.enter) &&
        !matchesKey(data, Key.shift("enter"))
      ) {
        const text = this.editor.getText().trim();
        const a = this.currentAnswer();
        a.customText = text;
        // A free-text escape answer overrides any checkbox selections.
        a.selectedOptionIndices = [];
        this.choiceEditMode = false;
        this.advanceOrConfirm();
        return;
      }
      this.editor.handleInput(data);
      this.invalidate();
      this.requestRender();
      return;
    }

    // Cancel — confirm first if any answers have been provided
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.hasAnyAnswers()) {
        this.showingCancelConfirmation = true;
        this.invalidate();
        this.requestRender();
      } else {
        this.cancel();
      }
      return;
    }

    // Tab / Shift+Tab for question navigation (both modes)
    if (matchesKey(data, Key.tab)) {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.requestRender();
      }
      return;
    }

    // --- Choice question (option list) ---
    if (this.isChoice()) {
      if (matchesKey(data, Key.up)) {
        this.optionCursor = Math.max(0, this.optionCursor - 1);
        this.invalidate();
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.optionCursor = Math.min(
          this.choiceRowCount() - 1,
          this.optionCursor + 1,
        );
        this.invalidate();
        this.requestRender();
        return;
      }
      // Space toggles in multiSelect (no-op on the "Type something" row).
      if (
        matchesKey(data, Key.space) &&
        this.currentQuestion().multiSelect &&
        !this.isOtherRow(this.optionCursor)
      ) {
        this.chooseCurrentOption();
        return;
      }
      // Enter: in multiSelect, advance/confirm (unless on the escape row, which
      // opens the editor); in single-select, choose immediately.
      if (matchesKey(data, Key.enter)) {
        const q = this.currentQuestion();
        if (q.multiSelect && !this.isOtherRow(this.optionCursor)) {
          this.advanceOrConfirm();
          return;
        }
        this.chooseCurrentOption();
        return;
      }
      return;
    }

    // --- Free-text question (editor) ---

    // Arrow up/down for question navigation when editor is empty
    if (matchesKey(data, Key.up) && this.editor.getText() === "") {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.requestRender();
        return;
      }
    }
    if (matchesKey(data, Key.down) && this.editor.getText() === "") {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.requestRender();
        return;
      }
    }

    // Plain Enter: advance to next question or confirm on last
    // Shift+Enter: newline (handled by editor below)
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.saveCurrentAnswer();
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
      } else {
        this.showingConfirmation = true;
      }
      this.invalidate();
      this.requestRender();
      return;
    }

    // Everything else goes to the editor
    this.editor.handleInput(data);
    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const t = this.theme;
    const lines: string[] = [];
    const boxWidth = Math.min(width - 4, 120);
    const contentWidth = boxWidth - 4; // 2 padding each side

    const hLine = (n: number) => "─".repeat(n);

    // Render a line inside the box with left padding and right fill
    const boxLine = (content: string, leftPad: number = 2): string => {
      const padded = " ".repeat(leftPad) + content;
      const cLen = visibleWidth(padded);
      const rightPad = Math.max(0, boxWidth - cLen - 2);
      return (
        t.fg("border", "│") +
        padded +
        " ".repeat(rightPad) +
        t.fg("border", "│")
      );
    };

    const emptyBoxLine = (): string => {
      return (
        t.fg("border", "│") + " ".repeat(boxWidth - 2) + t.fg("border", "│")
      );
    };

    // Ensure every output line is exactly `width` visible characters
    const padLine = (line: string): string => {
      return truncateToWidth(
        line + " ".repeat(Math.max(0, width - visibleWidth(line))),
        width,
        "",
      );
    };

    // Top border
    lines.push(padLine(t.fg("border", "╭" + hLine(boxWidth - 2) + "╮")));

    // Title
    const title = `${t.bold(t.fg("accent", "Questions"))} ${t.fg("dim", `(${this.currentIndex + 1}/${this.questions.length})`)}`;
    lines.push(padLine(boxLine(title)));

    // Separator
    lines.push(padLine(t.fg("border", "├" + hLine(boxWidth - 2) + "┤")));

    // Progress dots
    const dots: string[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const answered = this.isAnswered(i);
      const current = i === this.currentIndex;
      if (current) {
        dots.push(t.fg("accent", "●"));
      } else if (answered) {
        dots.push(t.fg("success", "●"));
      } else {
        dots.push(t.fg("dim", "○"));
      }
    }
    lines.push(padLine(boxLine(dots.join(" "))));
    lines.push(padLine(emptyBoxLine()));

    // Current question
    const q = this.currentQuestion();
    const questionText = `${t.bold("Q:")} ${q.question}`;
    for (const wl of wrapTextWithAnsi(questionText, contentWidth)) {
      lines.push(padLine(boxLine(wl)));
    }

    // Context
    if (q.context) {
      lines.push(padLine(emptyBoxLine()));
      const contextText = t.fg("muted", `> ${q.context}`);
      for (const wl of wrapTextWithAnsi(contextText, contentWidth - 2)) {
        lines.push(padLine(boxLine(wl)));
      }
    }

    lines.push(padLine(emptyBoxLine()));

    // Answer area — choice list or free-text editor depending on the question.
    const answerPrefix = t.bold("A: ");
    const answerPrefixWidth = visibleWidth(answerPrefix);

    if (this.isChoice() && !this.choiceEditMode) {
      // Option list (single-select or checkbox). The trailing row is the
      // "Type something" free-text escape.
      const a = this.currentAnswer();
      const selected = new Set(a.selectedOptionIndices);
      const opts = q.options ?? [];
      const multi = q.multiSelect === true;

      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        if (!opt) continue; // loop bound guarantees this; guard for noUncheckedIndexedAccess
        const onCursor = i === this.optionCursor;
        const cursor = onCursor ? t.fg("accent", "> ") : "  ";
        const checked = selected.has(i);
        // Checkboxes for multiSelect, radio-style bullet for single-select.
        const marker = multi
          ? checked
            ? t.fg("success", "[x] ")
            : t.fg("dim", "[ ] ")
          : checked
            ? t.fg("success", "(•) ")
            : t.fg("dim", "( ) ");
        const labelColor = onCursor ? "accent" : "text";
        const label = t.fg(labelColor, `${i + 1}. ${opt.label}`);
        for (const wl of wrapTextWithAnsi(
          cursor + marker + label,
          contentWidth,
        )) {
          lines.push(padLine(boxLine(wl)));
        }
        if (opt.description) {
          const desc = t.fg("muted", opt.description);
          for (const wl of wrapTextWithAnsi(desc, contentWidth - 5)) {
            lines.push(padLine(boxLine("     " + wl)));
          }
        }
      }

      // "Type something" escape row.
      const otherIdx = opts.length;
      const onOther = this.optionCursor === otherIdx;
      const otherCursor = onOther ? t.fg("accent", "> ") : "  ";
      const typed = a.customText.trim();
      const otherLabel = t.fg(
        onOther ? "accent" : "text",
        `${otherIdx + 1}. Type something`,
      );
      const otherSuffix = typed ? t.fg("muted", `  (${typed})`) : "";
      lines.push(
        padLine(
          boxLine(
            truncateToWidth(
              otherCursor + otherLabel + otherSuffix,
              contentWidth,
            ),
          ),
        ),
      );
    } else {
      // Free-text editor (free-text question, or the "Type something" escape).
      const editorWidth = contentWidth - 4 - answerPrefixWidth;
      const editorLines = this.editor.render(editorWidth);
      // Skip first and last lines (editor border lines)
      for (let i = 1; i < editorLines.length - 1; i++) {
        if (i === 1) {
          lines.push(padLine(boxLine(answerPrefix + editorLines[i])));
        } else {
          lines.push(
            padLine(boxLine(" ".repeat(answerPrefixWidth) + editorLines[i])),
          );
        }
      }
    }

    lines.push(padLine(emptyBoxLine()));

    // Footer separator
    lines.push(padLine(t.fg("border", "├" + hLine(boxWidth - 2) + "┤")));

    // Confirmation or controls
    if (this.showingConfirmation) {
      const msg = `${t.fg("warning", "Submit all answers?")} ${t.fg("dim", "(Enter/y to confirm, Esc/n to cancel)")}`;
      lines.push(padLine(boxLine(truncateToWidth(msg, contentWidth))));
    } else if (this.showingCancelConfirmation) {
      const msg = `${t.fg("warning", "Discard all answers?")} ${t.fg("dim", "(Enter/y to discard, Esc/n to go back)")}`;
      lines.push(padLine(boxLine(truncateToWidth(msg, contentWidth))));
    } else {
      // Controls vary by mode so the hints match the keys that actually work.
      let controls: string;
      if (this.isChoice() && this.choiceEditMode) {
        controls = `${t.fg("dim", "Enter")} confirm · ${t.fg("dim", "Esc")} back to options`;
      } else if (this.isChoice() && this.currentQuestion().multiSelect) {
        controls = `${t.fg("dim", "↑↓")} move · ${t.fg("dim", "Space")} toggle · ${t.fg("dim", "Enter")} next · ${t.fg("dim", "Tab")} jump · ${t.fg("dim", "Esc")} cancel`;
      } else if (this.isChoice()) {
        controls = `${t.fg("dim", "↑↓")} move · ${t.fg("dim", "Enter")} select · ${t.fg("dim", "Tab")} jump · ${t.fg("dim", "Esc")} cancel`;
      } else {
        controls = `${t.fg("dim", "Tab/Enter")} next · ${t.fg("dim", "Shift+Tab")} prev · ${t.fg("dim", "Shift+Enter")} newline · ${t.fg("dim", "Esc")} cancel`;
      }
      lines.push(padLine(boxLine(truncateToWidth(controls, contentWidth))));
    }

    // Model info (only when extraction was used)
    if (this.modelId) {
      const modelInfo = t.fg("dim", `model: ${this.modelId}`);
      lines.push(padLine(boxLine(truncateToWidth(modelInfo, contentWidth))));
    }

    // Bottom border
    lines.push(padLine(t.fg("border", "╰" + hLine(boxWidth - 2) + "╯")));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

// --- Shared widget runner ---

/**
 * Open the interactive Q&A widget for `questions` and resolve to the formatted
 * transcript text (question + options + answers), or `null` if the user
 * cancelled. Shared by the tool path and the `/answer` command path so both
 * record the full Q&A identically.
 *
 * Emits `answer:open` / `answer:close` around the widget (other extensions use
 * these to pause/resume their own UI, e.g. the working message).
 */
// Exported for unit tests (the non-tui routing below is the core of the
// remote-host fix); the TUI branch still needs a manual check.
export async function runQnAWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  questions: ExtractedQuestion[],
  options?: { modelId?: string },
): Promise<string | null> {
  // Non-terminal hosts (pilot) can't render the TUI component — ctx.ui.custom
  // rejects there. pilot instead exposes a structured `qna` form on its UI bridge
  // (PiUiBridge.qna), reachable only because pi hands extensions the RAW, UNWRAPPED
  // bridge as `ctx.ui` (the `as unknown as ExtensionUIContext` cast at
  // pi-driver.ts bindExtensions). `qna` is NOT on pi's typed ExtensionUIContext.
  // PILOT OWNS BOTH SIDES OF THIS SEAM now: this extension calls `ctx.ui.qna`, and
  // `PiUiBridge` implements it — so the coupling is intentional, not incidental.
  // The `ctx.mode !== "tui"` gate is the branch that fires under pilot (ctx.mode is
  // "rpc" there — pi-driver.ts bindExtensions); the TUI `QnAComponent` path below is
  // inert under pilot but STAYS because answer.ts is shared with pi's TUI. Use it
  // when present, formatting the returned answers through the same formatQnA the
  // TUI path uses; without it, degrade with a notice instead of throwing an
  // unsupported-capability error that aborts the tool call. (The canary
  // ui-bridge-coupling.test.ts keeps this loud.)
  if (ctx.mode !== "tui") {
    const remoteQna = (
      ctx.ui as {
        qna?: (
          questions: ExtractedQuestion[],
          opts?: { title?: string },
        ) => Promise<QnAAnswer[] | null>;
      }
    ).qna;
    if (typeof remoteQna === "function") {
      pi.events.emit("answer:open", undefined);
      const answers = await remoteQna.call(ctx.ui, questions);
      pi.events.emit("answer:close", undefined);
      return answers ? formatQnA(questions, answers) : null;
    }
    ctx.ui.notify(
      "Interactive questions need a terminal or the pilot app — run pi in a terminal for this one.",
      "warning",
    );
    return null;
  }

  pi.events.emit("answer:open", undefined);
  const result = await ctx.ui.custom<string | null>((tui, theme, kb, done) => {
    const component = new QnAComponent(
      questions,
      tui,
      theme,
      done,
      () => tui.requestRender(),
      {
        modelId: options?.modelId,
        keybindings: kb,
        onToggleExpand: () => {
          ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
        },
      },
    );

    return {
      render: (w: number) => component.render(w),
      invalidate: () => component.invalidate(),
      handleInput: (data: string) => component.handleInput(data),
      // Focusable: propagate to component
      get focused() {
        return component.focused;
      },
      set focused(value: boolean) {
        component.focused = value;
      },
    };
  });
  pi.events.emit("answer:close", undefined);
  return result;
}

// --- Tool: LLM-callable `answer` ---

/**
 * Schema for the `answer` tool. The LLM supplies questions DIRECTLY (no
 * extraction model). Each question is free-text by default; supplying `options`
 * turns it into a choice list, and `multiSelect` turns that into checkboxes.
 */
const AnswerOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({
      description: "Optional one-line clarification of the option",
    }),
  ),
});

const AnswerQuestionSchema = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  context: Type.Optional(
    Type.String({
      description: "Optional context that helps the user answer the question",
    }),
  ),
  options: Type.Optional(
    Type.Array(AnswerOptionSchema, {
      description:
        "Selectable choices for this question. Strongly preferred: supply these whenever you can name plausible answers (put your recommended choice first; the form always adds a free-text escape for anything you didn't anticipate). Omit ONLY for a question you genuinely cannot enumerate — a bare free-text question is rarely worth a form, since the user can just type in the prompt editor.",
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "When true (and options are present), the user may select multiple options (checkboxes). Ignored without options.",
    }),
  ),
});

const AnswerParams = Type.Object({
  questions: Type.Array(AnswerQuestionSchema, {
    description: "One or more questions to ask the user in a single Q&A form.",
  }),
});

/**
 * Build the LLM-callable `answer` tool. A factory (rather than a module-level
 * const) because `execute` needs the `pi` handle to open the widget via the
 * shared `runQnAWidget` runner.
 */
function createAnswerTool(pi: ExtensionAPI) {
  return defineTool({
    name: "answer",
    label: "Answer",
    description:
      "Ask the user one or more multiple-choice questions interactively in a single Q&A form. " +
      "Give each question `options` (selectable choices; set `multiSelect: true` for checkboxes) — " +
      "the form always adds a free-text escape, so options plus that escape covers almost everything. " +
      "A question with no `options` (bare free-text) is a rare fallback for when you genuinely cannot " +
      "name any choice, not a default: the user can already type free text in the prompt editor. " +
      "Use this instead of asking inline when you have one or more questions whose answers you need to proceed.",
    promptSnippet:
      "Ask the user one or more multiple-choice questions in one form",
    promptGuidelines: [
      "Use the answer tool when you need the user to answer one or more questions before continuing; prefer it over inline questions when you have a batch or want multiple-choice answers.",
      "Give every question `options` whenever you can name plausible choices (recommended one first); rely on the form's built-in free-text escape for the unanticipated. Reserve a bare free-text question (no `options`) for the rare case where you truly cannot enumerate any choice — it is not a co-equal default, since the user can already type free text in the prompt editor. Set `multiSelect: true` only when more than one option can legitimately be picked.",
    ],
    parameters: AnswerParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // No `ctx.mode` gate: runQnAWidget renders the TUI widget in a terminal and
      // falls back to the host's structured form (pilot) otherwise, so the tool
      // works in both. It only no-ops on a non-terminal host with no form support.
      if (params.questions.length === 0) {
        throw new Error("answer tool requires at least one question");
      }

      const questions: ExtractedQuestion[] = params.questions.map((q) => ({
        question: q.question,
        context: q.context,
        // Drop empty option arrays so they render free-text, not an empty list.
        options:
          Array.isArray(q.options) && q.options.length > 0
            ? q.options
            : undefined,
        multiSelect: q.multiSelect,
      }));

      const result = await runQnAWidget(pi, ctx, questions);

      if (result === null) {
        return {
          content: [
            {
              type: "text",
              text: "User cancelled — did not answer the questions.",
            },
          ],
          details: { cancelled: true },
        };
      }

      // Persist the full Q&A (questions + options + answers) for the LLM.
      return {
        content: [{ type: "text", text: result }],
        details: { cancelled: false },
      };
    },
  });
}

// --- Crash recovery ---

/** One entry from `sessionManager.getBranch()`. Typed structurally so the
 *  detector stays pure and unit-testable without pi's session types. */
type BranchEntry = { type: string; message?: unknown };

/** Narrow a `SessionEntry` to its `SessionMessageEntry` variant.
 *
 * `SessionEntryBase.type` is `string` (not a literal), so the runtime check
 * `entry.type === "message"` does NOT narrow the `SessionEntry` union in TS —
 * only `SessionMessageEntry` has `.message`, so accessing it directly is a
 * type error (the blind spot this file lived in hid it). This predicate mirrors
 * pi's own runtime guard (`entry.type === "message"`) and gives TS the narrowing
 * pi's JS source never needed. */
function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message";
}

/**
 * Detect a Q&A that went down with the form open. If the LAST message on the
 * branch is an assistant turn that called the `answer` tool and never received a
 * result, the run crashed/was killed mid-prompt — pi resumes with a dangling
 * answer tool call, doesn't re-run it, and doesn't auto-continue. Return its
 * questions so a resume can re-open the form; null otherwise.
 *
 * "LAST message" is the guard for "the last action was an unfinished answer
 * call": if the user already moved on (answered something else after), we don't
 * re-pop. Pure + exported for unit tests.
 */
export function pendingAnswerQuestions(
  branch: readonly BranchEntry[],
): ExtractedQuestion[] | null {
  let lastMessage: unknown;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "message") {
      lastMessage = branch[i]!.message;
      break;
    }
  }
  if (
    !lastMessage ||
    typeof lastMessage !== "object" ||
    (lastMessage as { role?: unknown }).role !== "assistant"
  ) {
    return null;
  }
  const content = (lastMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const call = content.find(
    (c): c is { type: "toolCall"; name: string; arguments?: unknown } =>
      !!c &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "toolCall" &&
      (c as { name?: unknown }).name === "answer",
  );
  if (!call) return null;
  const raw = (call.arguments as { questions?: unknown } | undefined)
    ?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions = raw
    .map((q): ExtractedQuestion | null => {
      if (!q || typeof q !== "object") return null;
      const obj = q as Record<string, unknown>;
      const question = typeof obj.question === "string" ? obj.question : "";
      if (!question) return null;
      return {
        question,
        context: typeof obj.context === "string" ? obj.context : undefined,
        options:
          Array.isArray(obj.options) && obj.options.length > 0
            ? (obj.options as ExtractedQuestion["options"])
            : undefined,
        multiSelect: obj.multiSelect === true,
      };
    })
    .filter((q): q is ExtractedQuestion => q !== null);
  return questions.length > 0 ? questions : null;
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  pi.registerTool(createAnswerTool(pi));

  // Register the background-model flag so `getFlag` can read it. Pilot threads the
  // value in warmUp (Chunk 1); we only consume it here. `type:"string"` matches how
  // pi threads it. Per-extension namespace, so session-namer registering the same flag
  // name is independent (pi's loader keys flag reads on the caller's own registration).
  pi.registerFlag(BACKGROUND_MODEL_FLAG, {
    description:
      "Pilot's background model spec (provider/model[:thinking]) for cheap out-of-band calls",
    type: "string",
  });

  const answerHandler = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("answer requires interactive mode", "error");
      return;
    }

    if (!ctx.model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }

    // Find the last assistant message on the current branch
    const branch = ctx.sessionManager.getBranch();
    let lastAssistantText: string | undefined;

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      // SessionEntryBase.type is typed `string` (not a literal), so the
      // `entry.type === "message"` check alone doesn't narrow the SessionEntry
      // union to SessionMessageEntry — only that variant has `.message`.
      // Mirrors pi's own runtime guard (agent-session.js: `entry.type === "message"
      // && entry.message.role === ...`) with an `is` predicate so TS narrows too.
      if (!entry || !isMessageEntry(entry)) continue;
      const msg = entry.message;
      if ("role" in msg && msg.role === "assistant") {
        if (msg.stopReason !== "stop") {
          ctx.ui.notify(
            `Last assistant message incomplete (${msg.stopReason})`,
            "error",
          );
          return;
        }
        const textParts = msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);
        if (textParts.length > 0) {
          lastAssistantText = textParts.join("\n");
          break;
        }
      }
    }

    if (!lastAssistantText) {
      ctx.ui.notify("No assistant messages found", "error");
      return;
    }

    // Build candidate model list for extraction. The background-model note goes to
    // stderr (like the subagent extension) so it surfaces without popping a modal over
    // the extraction spinner.
    const backgroundModelSpec = pi.getFlag(BACKGROUND_MODEL_FLAG);
    const candidates = await getCandidateModels(
      ctx.model,
      ctx.modelRegistry,
      (message) => process.stderr.write(`${message}\n`),
      typeof backgroundModelSpec === "string" ? backgroundModelSpec : undefined,
    );

    if (candidates.length === 0) {
      ctx.ui.notify("No models available for extraction", "error");
      return;
    }

    // Extract questions with a loading spinner, trying candidates in order
    const extractionResult = await ctx.ui.custom<{
      result: ExtractionResult;
      modelId: string;
    } | null>((tui, theme, _kb, done) => {
      const loader = new BorderedLoader(tui, theme, `Extracting questions...`);
      loader.onAbort = () => done(null);

      const tryExtract = async (
        candidate: ModelCandidate,
      ): Promise<ExtractionResult> => {
        const userMessage: UserMessage = {
          role: "user",
          content: [{ type: "text", text: lastAssistantText! }],
          timestamp: Date.now(),
        };

        const response = await complete(
          candidate.model,
          { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
          {
            apiKey: candidate.apiKey,
            headers: candidate.headers,
            signal: loader.signal,
          },
        );

        if (response.stopReason === "aborted") {
          throw new Error("aborted");
        }

        const responseText = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        if (!responseText) {
          const contentTypes =
            response.content.map((c) => c.type).join(", ") || "(empty)";
          throw new Error(
            `No text content (stop: ${response.stopReason}, types: ${contentTypes})`,
          );
        }

        return parseExtractionResult(responseText);
      };

      const doExtract = async (): Promise<{
        result: ExtractionResult;
        modelId: string;
      } | null> => {
        const errors: string[] = [];

        for (const candidate of candidates) {
          // Update spinner to show which model is being tried
          (loader as any).loader?.setMessage?.(
            `Extracting questions via ${candidate.model.id}...`,
          );
          tui.requestRender();
          try {
            const result = await tryExtract(candidate);
            return { result, modelId: candidate.model.id };
          } catch (err) {
            if (err instanceof Error && err.message === "aborted") return null;
            const message = err instanceof Error ? err.message : String(err);
            errors.push(
              `${candidate.model.provider}/${candidate.model.id}: ${message}`,
            );
          }
        }

        throw new Error(
          `All ${candidates.length} model(s) failed:\n${errors.join("\n")}`,
        );
      };

      doExtract()
        .then(done)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          // Schedule notification after the custom UI closes
          setTimeout(
            () => ctx.ui.notify(`Extraction failed: ${message}`, "error"),
            0,
          );
          done(null);
        });

      return loader;
    });

    if (extractionResult === null) {
      return;
    }

    if (extractionResult.result.questions.length === 0) {
      ctx.ui.notify("No questions found in the last message", "info");
      return;
    }

    // Show the interactive Q&A form (extraction path: free-text questions only,
    // so no options are passed — the widget renders them as free-text editors).
    const answersResult = await runQnAWidget(
      pi,
      ctx,
      extractionResult.result.questions,
      { modelId: extractionResult.modelId },
    );

    if (answersResult === null) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const message =
      "I answered your questions in the following way:\n\n" + answersResult;
    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
    } else {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    }
  };

  pi.registerCommand("answer", {
    description:
      "Extract questions from last assistant message into interactive Q&A",
    handler: (_args, ctx) => answerHandler(ctx),
  });

  pi.registerShortcut("ctrl+.", {
    description: "Extract and answer questions",
    handler: answerHandler,
  });

  // Crash recovery: if a previous run went down while the `answer` tool was
  // awaiting (the form was open), the session resumes with a dangling answer
  // tool call and no result. pi won't re-run the tool or auto-continue (verified
  // empirically), so we re-open the form and deliver the answers as a user
  // message — the same path the /answer command uses; pi reconciles the dangling
  // call on the next turn. Fired detached so it never blocks session load: the
  // form just waits for a client to answer.
  //
  // Remote hosts (pilot) only. There, ctx.ui.qna emits an event the client
  // renders whenever it connects, so session-load timing is irrelevant. In a
  // real terminal, ctx.ui.custom can't mount this early in session_start (the
  // TUI render loop isn't up yet) and hangs invisibly — so TUI recovery is
  // intentionally skipped until pi grows a post-ready / "UI is interactive" hook.
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "resume" && event.reason !== "startup") return;
    if (!ctx.hasUI || ctx.mode === "tui") return;
    const questions = pendingAnswerQuestions(ctx.sessionManager.getBranch());
    if (!questions) return;
    void (async () => {
      try {
        const result = await runQnAWidget(pi, ctx, questions);
        if (result === null) return; // user dismissed — leave the call dangling
        const message =
          "I answered your questions in the following way:\n\n" + result;
        if (ctx.isIdle()) pi.sendUserMessage(message);
        else pi.sendUserMessage(message, { deliverAs: "followUp" });
      } catch (err) {
        ctx.ui.notify(
          `Could not restore the answer form: ${String(err)}`,
          "error",
        );
      }
    })();
  });
}

//! Parsing `polytoken models` text output into pantoken's `ModelOption[]`.
//!
//! Port of `server/src/polytoken/models.ts`.
//!
//! `polytoken models` prints a human-readable config dump (NOT JSON — there's no
//! --format flag on this subcommand). The shape (observed, polytoken 0.3.3):
//!
//! ```text
//! default_model: umans/umans-glm-5.2
//! default_small_model: umans/umans-flash
//!
//! models:
//! - deepseek/deepseek-v4-pro
//!   provider: deepseek/deepseek-v4-pro
//!   variant: claude
//!   tool_loading: eager
//!   reasoning: effort set=deepseek_v4; levels=high (default), max, none; can_disable=yes
//!   selectable: deepseek/deepseek-v4-pro, deepseek/deepseek-v4-pro(none), ...
//! ```
//!
//! The model id is the `- <id>` header line; `provider` is often == the id;
//! `selectable` is a comma-separated list of `<id>` / `<id>(<reasoning_level>)`
//! variants. The reasoning `levels` (minus the `(default)` marker) are the
//! model's thinking levels.
//!
//! This is a pure parser over the text — unit-testable without invoking the binary.
//! The driver shells out to `polytoken models` and hands the stdout here.

use pantoken_protocol::session_driver::ModelOption;

/// The parsed `polytoken models` output: the model list + the two default markers.
/// The defaults are NOT `ModelOption`s — they're config markers
/// (`default_model` / `default_small_model`) the Settings panel may surface later;
/// the model list is what the picker renders.
#[derive(Debug, Clone, Default)]
pub struct ParsedModels {
    pub models: Vec<ModelOption>,
    pub default_model: Option<String>,
    pub default_small_model: Option<String>,
}

/// Parse a `reasoning:` line's levels list into thinking levels.
/// Input shape: `effort set=<set>; levels=high (default), max, none; can_disable=yes`
/// → extract the `levels=` segment, strip the `(default)` marker, split on `,`, trim.
/// Returns `[]` when the segment is absent (a non-reasoning model).
fn parse_reasoning_levels(reasoning_line: &str) -> Vec<String> {
    // Extract the `levels=` segment (up to the next `;` or end of string).
    let Some(after_levels) = reasoning_line.find("levels=") else {
        return Vec::new();
    };
    let rest = &reasoning_line[after_levels + "levels=".len()..];
    let segment = rest.split(';').next().unwrap_or("");
    segment
        .split(',')
        .map(|l| {
            // Strip the `(default)` marker (case-insensitive) and trim.
            l.replace("(default)", "")
                .replace("(DEFAULT)", "")
                .trim()
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// Extract the first non-whitespace token after a literal prefix at the start
/// of a line. Returns `None` if the line doesn't start with the prefix or there
/// is no token after it.
fn first_token_after_prefix<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(prefix)?;
    rest.split_whitespace().next()
}

/// Parse `polytoken models` text output into `Vec<ModelOption>` (+ default markers).
/// Pure — no I/O. Loud on a malformed header line: a model block that doesn't start
/// with `- <id>` is skipped (never crashes the whole list on one bad entry).
pub fn parse_models(stdout: &str) -> ParsedModels {
    let mut default_model: Option<String> = None;
    let mut default_small_model: Option<String> = None;
    let mut models: Vec<ModelOption> = Vec::new();

    // Track the current model block as we walk the lines. A block starts at
    // `- <id>` (indented 0 under `models:`) and its fields are indented further.
    let mut current_id: Option<String> = None;
    let mut current_provider: Option<String> = None;
    let mut current_reasoning: Option<String> = None;
    // Only treat `- <id>` lines as model headers once we've seen the `models:`
    // section marker. Set on the bare `models:` line; stays true after.
    let mut in_models_section = false;

    // flush closure inlined as a macro-like block.
    let flush = |cid: &mut Option<String>,
                 cprov: &mut Option<String>,
                 creason: &mut Option<String>,
                 models: &mut Vec<ModelOption>| {
        let Some(id) = cid.take() else {
            *cprov = None;
            *creason = None;
            return;
        };
        // The model id (e.g. `deepseek/deepseek-v4-pro`) already carries its
        // provider prefix; polytoken's `provider:` field is often identical.
        // Split on the first `/` so pantoken's provider-grouped picker gets a
        // sensible group key — but fall back to the whole id when there's no
        // slash.
        let provider = cprov
            .clone()
            .unwrap_or_else(|| id.split('/').next().unwrap_or(&id).to_string());
        let thinking_levels = creason.as_ref().map(|r| parse_reasoning_levels(r));
        models.push(ModelOption {
            provider,
            model_id: id.clone(),
            label: id,
            thinking_levels,
        });
        *cprov = None;
        *creason = None;
    };

    for raw in stdout.split('\n') {
        // Strip a trailing \r (Windows line endings).
        let line = raw.strip_suffix('\r').unwrap_or(raw);

        // Top-level default markers (no leading indent).
        if let Some(token) = first_token_after_prefix(line, "default_model:") {
            default_model = Some(token.to_string());
            continue;
        }
        if let Some(token) = first_token_after_prefix(line, "default_small_model:") {
            default_small_model = Some(token.to_string());
            continue;
        }
        // The `models:` section marker — a bare top-level line.
        if line.trim() == "models:" {
            in_models_section = true;
            continue;
        }
        // A new model block: `- <id>` (only recognized inside the models: section).
        // Matches `^-\s+(\S+)` — starts with `-` then whitespace, then non-ws token.
        if in_models_section {
            if let Some(id) = parse_model_header(line) {
                flush(
                    &mut current_id,
                    &mut current_provider,
                    &mut current_reasoning,
                    &mut models,
                );
                current_id = Some(id);
                continue;
            }
        }
        if current_id.is_none() {
            continue;
        }
        // Field lines are indented further than the `- ` header.
        // `^\s+provider:\s*(\S+)`
        if let Some(token) = parse_indented_field(line, "provider:") {
            current_provider = Some(token.to_string());
            continue;
        }
        // `^\s+reasoning:\s*(.*)$`
        if let Some(rest) = parse_indented_field_rest(line, "reasoning:") {
            current_reasoning = Some(rest.to_string());
            continue;
        }
    }
    flush(
        &mut current_id,
        &mut current_provider,
        &mut current_reasoning,
        &mut models,
    );
    ParsedModels {
        models,
        default_model,
        default_small_model,
    }
}

/// Parse a `- <id>` model header line. Returns the id token if the line matches
/// `^-\s+(\S+)`, else `None`.
fn parse_model_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix('-')?;
    // Must have at least one whitespace char after `-`.
    let rest = rest.strip_prefix(|c: char| c.is_whitespace())?;
    let token = rest.split_whitespace().next()?;
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Parse an indented `provider:` field line. Matches `^\s+provider:\s*(\S+)`.
/// Returns the first non-whitespace token after the colon.
fn parse_indented_field(line: &str, field: &str) -> Option<String> {
    // Must start with whitespace (indented field).
    let first = line.chars().next()?;
    if !first.is_whitespace() {
        return None;
    }
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix(field)?;
    let token = rest.split_whitespace().next()?;
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// Parse an indented `reasoning:` field line, returning everything after the
/// colon. Matches `^\s+reasoning:\s*(.*)$`.
fn parse_indented_field_rest(line: &str, field: &str) -> Option<String> {
    let first = line.chars().next()?;
    if !first.is_whitespace() {
        return None;
    }
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix(field)?;
    Some(rest.trim_start().to_string())
}

/// Split a full `provider/id` registry name into the picker's `{provider, modelId}`
/// shape. `modelId` stays the FULL registry name (polytoken's POST /model key),
/// NOT the bare id — see `setModel` notes. Falls back to the whole string as both
/// when there's no slash (mirrors `parseModels`' provider fallback).
pub fn default_model_ref(marker: &str) -> ModelRef {
    match marker.find('/') {
        Some(slash) => ModelRef {
            provider: marker[..slash].to_string(),
            model_id: marker.to_string(),
        },
        None => ModelRef {
            provider: marker.to_string(),
            model_id: marker.to_string(),
        },
    }
}

/// The model string to POST to /model. Polytoken's `ModelConfig.name` (the
/// registry key) is the FULL `provider/id`, which is exactly what
/// `ModelOption.model_id` and the default markers already carry — so the POST
/// key IS the model_id, unmodified. Centralized here so `set_model`/`new_session`
/// share one tested path instead of each inlining a (previously buggy)
/// `${provider}/${modelId}` join.
pub fn model_post_key(model_id: &str) -> String {
    model_id.to_string()
}

/// The provider + model-id pair returned by [`default_model_ref`].
#[derive(Debug, Clone)]
pub struct ModelRef {
    pub provider: String,
    pub model_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_OUTPUT: &str = "\
default_model: umans/umans-glm-5.2
default_small_model: umans/umans-flash

models:
- deepseek/deepseek-v4-pro
  provider: deepseek/deepseek-v4-pro
  variant: claude
  tool_loading: eager
  reasoning: effort set=deepseek_v4; levels=high (default), max, none; can_disable=yes
  selectable: deepseek/deepseek-v4-pro, deepseek/deepseek-v4-pro(none), deepseek/deepseek-v4-pro(high), deepseek/deepseek-v4-pro(max)
- umans/umans-glm-5.2 (default, dynamic)
  provider: umans/umans-glm-5.2
  variant: other
  tool_loading: eager
  reasoning: effort set=custom; levels=high (default), max, none; can_disable=yes
  selectable: umans/umans-glm-5.2, umans/umans-glm-5.2(none), umans/umans-glm-5.2(high), umans/umans-glm-5.2(max)
- umans/umans-flash (small, dynamic)
  provider: umans/umans-flash
  variant: other
  tool_loading: eager
  reasoning: effort set=custom; levels=low, medium (default), high, none; can_disable=yes
  selectable: umans/umans-flash, umans/umans-flash(none), umans/umans-flash(low), umans/umans-flash(medium), umans/umans-flash(high), umans/umans-flash(none)
";

    #[test]
    fn parses_the_real_observed_output() {
        let out = parse_models(REAL_OUTPUT);
        assert_eq!(out.default_model.as_deref(), Some("umans/umans-glm-5.2"));
        assert_eq!(
            out.default_small_model.as_deref(),
            Some("umans/umans-flash")
        );
        assert_eq!(out.models.len(), 3);

        let pro = &out.models[0];
        assert_eq!(pro.provider, "deepseek/deepseek-v4-pro");
        assert_eq!(pro.model_id, "deepseek/deepseek-v4-pro");
        assert_eq!(pro.label, "deepseek/deepseek-v4-pro");
        assert_eq!(
            pro.thinking_levels.as_deref(),
            Some(&["high".to_string(), "max".into(), "none".into()][..])
        );

        let glm = &out.models[1];
        assert_eq!(glm.model_id, "umans/umans-glm-5.2");
        assert_eq!(
            glm.thinking_levels.as_deref(),
            Some(&["high".to_string(), "max".into(), "none".into()][..])
        );

        let flash = &out.models[2];
        assert_eq!(flash.model_id, "umans/umans-flash");
        assert_eq!(
            flash.thinking_levels.as_deref(),
            Some(
                &[
                    "low".to_string(),
                    "medium".into(),
                    "high".into(),
                    "none".into()
                ][..]
            )
        );
    }

    #[test]
    fn splits_provider_from_model_id_on_first_slash() {
        let out = parse_models(
            "models:\n- anthropic/claude-sonnet-5\n  reasoning: levels=low (default), high; can_disable=yes\n",
        );
        assert_eq!(out.models.len(), 1);
        assert_eq!(out.models[0].provider, "anthropic");
        assert_eq!(out.models[0].model_id, "anthropic/claude-sonnet-5");
    }

    #[test]
    fn falls_back_to_whole_id_as_provider_when_no_slash() {
        let out =
            parse_models("models:\n- local-model\n  reasoning: levels=high; can_disable=yes\n");
        assert_eq!(out.models[0].provider, "local-model");
        assert_eq!(out.models[0].model_id, "local-model");
    }

    #[test]
    fn no_reasoning_line_yields_none_thinking_levels() {
        let out = parse_models("models:\n- base-model\n  provider: base-model\n");
        assert!(out.models[0].thinking_levels.is_none());
    }

    #[test]
    fn reasoning_levels_strip_default_marker_and_trim() {
        let out = parse_models(
            "models:\n- m1\n  reasoning: effort set=x; levels= minimal (default),  high , none ; can_disable=yes\n",
        );
        assert_eq!(
            out.models[0].thinking_levels.as_deref(),
            Some(&["minimal".to_string(), "high".into(), "none".into()][..])
        );
    }

    #[test]
    fn empty_output_yields_no_models_and_null_defaults() {
        let out = parse_models("");
        assert!(out.models.is_empty());
        assert!(out.default_model.is_none());
        assert!(out.default_small_model.is_none());
    }

    #[test]
    fn malformed_header_line_no_id_after_dash_is_skipped() {
        let out = parse_models("models:\n- \n- good-model\n  provider: good-model\n");
        assert_eq!(out.models.len(), 1);
        assert_eq!(out.models[0].model_id, "good-model");
    }

    #[test]
    fn crlf_line_endings_are_handled() {
        let crlf = REAL_OUTPUT.replace('\n', "\r\n");
        let out = parse_models(&crlf);
        assert_eq!(out.default_model.as_deref(), Some("umans/umans-glm-5.2"));
        assert_eq!(out.models.len(), 3);
        assert_eq!(
            out.models[0].thinking_levels.as_deref(),
            Some(&["high".to_string(), "max".into(), "none".into()][..])
        );
    }

    #[test]
    fn dash_bulleted_line_before_models_section_is_not_a_model() {
        let out = parse_models(
            "notes:\n- this is not a model\nmodels:\n- real-model\n  provider: real-model\n",
        );
        assert_eq!(out.models.len(), 1);
        assert_eq!(out.models[0].model_id, "real-model");
    }

    #[test]
    fn no_models_section_yields_no_models() {
        let out = parse_models("default_model: umans/umans-glm-5.2\n- stray dash line\n");
        assert!(out.models.is_empty());
        assert_eq!(out.default_model.as_deref(), Some("umans/umans-glm-5.2"));
    }

    #[test]
    fn default_model_ref_and_model_post_key() {
        let r = default_model_ref("umans/umans-glm-5.2");
        assert_eq!(r.provider, "umans");
        assert_eq!(r.model_id, "umans/umans-glm-5.2");

        let r2 = default_model_ref("local-model");
        assert_eq!(r2.provider, "local-model");
        assert_eq!(r2.model_id, "local-model");

        assert_eq!(model_post_key("umans/umans-glm-5.2"), "umans/umans-glm-5.2");
        assert_eq!(
            model_post_key("deepseek/deepseek-v4-pro"),
            "deepseek/deepseek-v4-pro"
        );
        assert_eq!(model_post_key("local-model"), "local-model");
    }
}

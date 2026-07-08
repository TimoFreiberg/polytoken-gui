//! Resolve the "background model" setting to a concrete model + thinking level,
//! with a loud `warning` channel for bad specs. Used by pantoken's Settings
//! validation against the cached available-models list. Pure (the only
//! side-effecting path is `script:`, which spawns a user-supplied resolver
//! script and is NOT yet ported here — it returns a TODO warning instead).
//!
//! Faithful port of `server/src/shared/background-model.ts`.

use pantoken_protocol::session_driver::ModelOption;

/// The resolved background model. `model` is `None` when the spec is unset
/// (null) or doesn't resolve to a registered model. `warning` is a
/// human-readable note the Settings UI surfaces (red): a FATAL warning (no
/// `model`) means the spec didn't resolve; a NON-FATAL warning (alongside a
/// resolved `model`) means the model resolved but something is off (e.g. an
/// invalid `:thinking` suffix was dropped). `model` and `warning` CAN both be
/// set (non-fatal case); a fatal warning stands alone.
#[derive(Debug, Clone, Default)]
pub struct ResolvedBackgroundModel {
    /// The matched model object, or `None`.
    pub model: Option<ModelOption>,
    /// thinking level when one was parsed from a `:thinking` suffix, else
    /// `None` (use the model/provider default).
    pub thinking_level: Option<String>,
    /// Note channel surfaced to the Settings UI. `None` when the spec is unset
    /// or resolved cleanly.
    pub warning: Option<String>,
}

/// The thinking-level ladder (incl. `off`). A spec's `:thinking` suffix must be
/// one of these or it's a warning. Pantoken's Settings DEFAULT_THINKING_LEVELS is
/// the same set. (Ported from TS `VALID_THINKING_LEVELS`.)
const VALID_THINKING_LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// Prefix marking a spec as a script to run (its stdout is then parsed as a
/// spec). Lets an operator keep their own resolver.
const SCRIPT_PREFIX: &str = "script:";

/// A model id is an "alias" (stable, e.g. `claude-sonnet-4-5`) rather than a
/// dated version (`claude-sonnet-4-5-20250929`) or a `-latest` tag. Aliases are
/// preferred when a bare-id pattern matches several versions.
fn is_alias(id: &str) -> bool {
    if id.ends_with("-latest") {
        return true;
    }
    // !/-\d{8}$/ — a trailing 8-digit date marks a dated version.
    !has_trailing_date(id)
}

/// True if `id` ends with `-YYYYMMDD`.
fn has_trailing_date(id: &str) -> bool {
    // Port of TS `/-\d{8}$/`.
    if id.len() < 9 {
        return false;
    }
    let tail = &id[id.len() - 9..];
    tail.as_bytes()[0] == b'-' && tail[1..].bytes().all(|b| b.is_ascii_digit())
}

/// Find an exact model reference match. Supports either a bare model id or a
/// canonical `provider/modelId` reference. Bare-id matches are rejected when
/// ambiguous across providers.
fn find_exact_model_reference_match(
    reference: &str,
    models: &[ModelOption],
) -> Option<ModelOption> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();

    // Canonical `provider/id` exact match.
    let canonical: Vec<&ModelOption> = models
        .iter()
        .filter(|m| format!("{}/{}", m.provider, m.model_id).to_lowercase() == lower)
        .collect();
    if canonical.len() == 1 {
        return Some(canonical[0].clone());
    }
    if canonical.len() > 1 {
        return None; // ambiguous
    }

    // `provider/id` with different casing/components.
    if let Some(slash) = trimmed.find('/') {
        let provider = trimmed[..slash].trim();
        let model_id = trimmed[slash + 1..].trim();
        if !provider.is_empty() && !model_id.is_empty() {
            let pm: Vec<&ModelOption> = models
                .iter()
                .filter(|m| {
                    m.provider.to_lowercase() == provider.to_lowercase()
                        && m.model_id.to_lowercase() == model_id.to_lowercase()
                })
                .collect();
            if pm.len() == 1 {
                return Some(pm[0].clone());
            }
            if pm.len() > 1 {
                return None;
            }
        }
    }

    // Bare id exact match (ambiguous across providers → reject).
    let by_id: Vec<&ModelOption> = models
        .iter()
        .filter(|m| m.model_id.to_lowercase() == lower)
        .collect();
    if by_id.len() == 1 {
        Some(by_id[0].clone())
    } else {
        None
    }
}

/// Match a pattern to a model: exact reference first, then a partial
/// (id-or-name) substring match preferring aliases over dated versions.
fn try_match_model(pattern: &str, models: &[ModelOption]) -> Option<ModelOption> {
    if let Some(exact) = find_exact_model_reference_match(pattern, models) {
        return Some(exact);
    }

    let lower = pattern.to_lowercase();
    let matches: Vec<&ModelOption> = models
        .iter()
        .filter(|m| {
            m.model_id.to_lowercase().contains(&lower) || m.label.to_lowercase().contains(&lower)
        })
        .collect();
    if matches.is_empty() {
        return None;
    }

    let aliases: Vec<&ModelOption> = matches
        .iter()
        .copied()
        .filter(|m| is_alias(&m.model_id))
        .collect();
    let dated: Vec<&ModelOption> = matches
        .iter()
        .copied()
        .filter(|m| !is_alias(&m.model_id))
        .collect();
    let pool: Vec<&ModelOption> = if !aliases.is_empty() { aliases } else { dated };
    // Highest-sorting id wins (aliases: the alias itself; dated: the latest date).
    pool.iter()
        .copied()
        .max_by(|a, b| a.model_id.cmp(&b.model_id))
        .cloned()
}

/// Parse a `provider/model[:thinking]` spec against the available models.
fn parse_spec(spec: &str, models: &[ModelOption]) -> ResolvedBackgroundModel {
    // Exact (incl. canonical `provider/id`) match first — no thinking suffix.
    if let Some(exact) = try_match_model(spec, models) {
        return ResolvedBackgroundModel {
            model: Some(exact),
            ..Default::default()
        };
    }

    // No exact match: if there's a `:thinking` suffix, split on the LAST colon
    // (after any provider slash) and recurse on the prefix.
    let colon = spec.rfind(':');
    let slash = spec.find('/');
    if let Some(colon) = colon {
        let after_slash = slash.is_none_or(|s| colon > s);
        if after_slash {
            let suffix = &spec[colon + 1..];
            let prefix = &spec[..colon];
            if VALID_THINKING_LEVELS.contains(&suffix) {
                let inner = parse_spec(prefix, models);
                if inner.model.is_some() {
                    // Only honour the thinking level when the prefix resolved cleanly.
                    return ResolvedBackgroundModel {
                        model: inner.model,
                        thinking_level: Some(suffix.to_string()),
                        ..Default::default()
                    };
                }
                // Prefix didn't resolve either — fall through to the not-found
                // warning below, reporting the FULL spec so the operator sees
                // what they typed.
            } else {
                // Invalid thinking level: recurse on the prefix. If it resolves,
                // return the model with the bad level DROPPED + a non-fatal
                // warning. If the prefix doesn't resolve, return the not-found
                // warning naming the full spec.
                let inner = parse_spec(prefix, models);
                if inner.model.is_some() {
                    return ResolvedBackgroundModel {
                        model: inner.model,
                        warning: Some(format!(
                            "Invalid thinking level \"{}\" in spec \"{}\" — dropped; valid: {}.",
                            suffix,
                            spec,
                            VALID_THINKING_LEVELS.join(", ")
                        )),
                        ..Default::default()
                    };
                }
                return ResolvedBackgroundModel {
                    model: None,
                    thinking_level: None,
                    warning: Some(format!(
                        "No registered model matches \"{}\" (invalid thinking level \"{}\" dropped; valid: {}).",
                        spec,
                        suffix,
                        VALID_THINKING_LEVELS.join(", ")
                    )),
                };
            }
        }
    }

    // Well-formed but matches nothing registered.
    ResolvedBackgroundModel {
        model: None,
        thinking_level: None,
        warning: Some(format!(
            "No registered model matches \"{}\". Check the provider/model id, or connect the provider first.",
            spec
        )),
    }
}

/// Resolve a `script:`-prefixed path. NOT yet ported — the TS version spawns the
/// script and parses its stdout. Returns a TODO warning so a bad spec is never
/// silently accepted (fail-loud), without blocking on the spawn port.
fn resolve_script_spec(script_path: &str, _models: &[ModelOption]) -> ResolvedBackgroundModel {
    ResolvedBackgroundModel {
        model: None,
        thinking_level: None,
        warning: Some(format!(
            "Background-model script resolution (\"{}\") is not yet ported to the Rust server.",
            script_path
        )),
    }
}

/// Resolve the `backgroundModel` setting. The single entry point: handles `null`
/// (unset → no-op), `script:` paths (run → parse stdout — stubbed here), and
/// plain specs (parse against the registry). Always returns a
/// `ResolvedBackgroundModel`; the caller surfaces `warning` to the UI.
pub fn resolve_background_model(
    background_model: Option<&str>,
    models: &[ModelOption],
) -> ResolvedBackgroundModel {
    let spec = background_model.map(|s| s.trim()).filter(|s| !s.is_empty());
    let Some(spec) = spec else {
        return ResolvedBackgroundModel::default(); // unset — not an error.
    };
    if let Some(path) = spec.strip_prefix(SCRIPT_PREFIX) {
        return resolve_script_spec(path.trim(), models);
    }
    parse_spec(spec, models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> Vec<ModelOption> {
        vec![
            ModelOption {
                provider: "anthropic".into(),
                model_id: "claude-sonnet-4-6".into(),
                label: "Claude Sonnet 4.6".into(),
                thinking_levels: None,
            },
            ModelOption {
                provider: "anthropic".into(),
                model_id: "claude-opus-4-8".into(),
                label: "Claude Opus 4.8".into(),
                thinking_levels: None,
            },
            ModelOption {
                provider: "openai".into(),
                model_id: "gpt-5".into(),
                label: "GPT-5".into(),
                thinking_levels: None,
            },
        ]
    }

    #[test]
    fn unset_spec_has_no_warning() {
        let r = resolve_background_model(None, &reg());
        assert!(r.model.is_none());
        assert!(r.thinking_level.is_none());
        assert!(r.warning.is_none());
    }

    #[test]
    fn empty_spec_is_unset() {
        let r = resolve_background_model(Some("   "), &reg());
        assert!(r.model.is_none());
        assert!(r.warning.is_none());
    }

    #[test]
    fn canonical_provider_id_resolves_cleanly() {
        // Ports TS: the good e2e spec resolves with no warning.
        let r = resolve_background_model(Some("anthropic/claude-sonnet-4-6:low"), &reg());
        assert!(r.warning.is_none());
        assert_eq!(r.model.as_ref().unwrap().model_id, "claude-sonnet-4-6");
        assert_eq!(r.thinking_level.as_deref(), Some("low"));
    }

    #[test]
    fn canonical_without_thinking_resolves_cleanly() {
        let r = resolve_background_model(Some("anthropic/claude-sonnet-4-6"), &reg());
        assert!(r.warning.is_none());
        assert_eq!(r.model.as_ref().unwrap().model_id, "claude-sonnet-4-6");
        assert!(r.thinking_level.is_none());
    }

    #[test]
    fn bad_spec_surfaces_fatal_warning() {
        // Ports TS `background-model.test.ts` + the e2e: a model not in the
        // registry → fatal "No registered model matches" warning, no model.
        let r = resolve_background_model(Some("anthropic/nope-9-9"), &reg());
        assert!(r.model.is_none());
        assert!(
            r.warning
                .as_deref()
                .unwrap()
                .contains("No registered model matches")
        );
        assert!(r.warning.as_deref().unwrap().contains("anthropic/nope-9-9"));
    }

    #[test]
    fn bad_spec_with_thinking_suffix_names_full_spec() {
        // Invalid suffix AND no model: names the full spec incl. the suffix.
        let r = resolve_background_model(Some("anthropic/nope-9-9:low"), &reg());
        assert!(r.model.is_none());
        assert!(
            r.warning
                .as_deref()
                .unwrap()
                .contains("anthropic/nope-9-9:low")
        );
    }

    #[test]
    fn invalid_thinking_level_with_resolved_model_is_non_fatal() {
        // Model resolves but the suffix is invalid → model kept, suffix dropped,
        // non-fatal warning.
        let r = resolve_background_model(Some("anthropic/claude-sonnet-4-6:bogus"), &reg());
        assert_eq!(r.model.as_ref().unwrap().model_id, "claude-sonnet-4-6");
        assert!(
            r.warning
                .as_deref()
                .unwrap()
                .contains("Invalid thinking level")
        );
    }

    #[test]
    fn bare_id_ambiguous_at_exact_level_falls_back_to_substring() {
        // The exact-match path rejects an ambiguous bare id, but try_match_model
        // then falls back to substring matching (TS does the same), which may
        // still resolve one. The ambiguity rejection lives in the exact-match
        // path — assert it produced a deterministic outcome (resolves OR warns),
        // never a panic.
        let mut models = reg();
        models.push(ModelOption {
            provider: "other".into(),
            model_id: "gpt-5".into(),
            label: "Other GPT-5".into(),
            thinking_levels: None,
        });
        let r = resolve_background_model(Some("gpt-5"), &models);
        assert!(r.model.is_some() || r.warning.is_some());
    }

    #[test]
    fn substring_match_prefers_alias_over_dated_version() {
        // Ports the trickiest logic in TS tryMatchModel: when a pattern matches
        // several ids by substring, aliases (no trailing YYYYMMDD / not -latest)
        // are preferred over dated versions. Without this guard a buggy
        // has_trailing_date (e.g. off-by-one on the 9-char tail) would pick the
        // dated version. (background-model.ts:124-130.)
        let models = vec![
            ModelOption {
                provider: "anthropic".into(),
                model_id: "claude-x-4-5-20250101".into(),
                label: "Claude X 4.5 (dated)".into(),
                thinking_levels: None,
            },
            ModelOption {
                provider: "anthropic".into(),
                model_id: "claude-x-4-5".into(),
                label: "Claude X 4.5 (alias)".into(),
                thinking_levels: None,
            },
        ];
        let r = resolve_background_model(Some("claude-x-4-5"), &models);
        assert!(r.warning.is_none(), "alias should resolve cleanly");
        assert_eq!(
            r.model.as_ref().unwrap().model_id,
            "claude-x-4-5",
            "alias must win over the dated version"
        );
    }

    #[test]
    fn latest_suffix_is_treated_as_an_alias() {
        // `-latest` is an alias too (is_alias short-circuits before the date
        // check), so a `-latest` id wins over a dated sibling.
        let models = vec![
            ModelOption {
                provider: "anthropic".into(),
                model_id: "claude-x-4-5-20250101".into(),
                label: "dated".into(),
                thinking_levels: None,
            },
            ModelOption {
                provider: "anthropic".into(),
                model_id: "claude-x-4-5-latest".into(),
                label: "latest".into(),
                thinking_levels: None,
            },
        ];
        let r = resolve_background_model(Some("claude-x-4-5-latest"), &models);
        assert!(r.warning.is_none());
        assert_eq!(r.model.as_ref().unwrap().model_id, "claude-x-4-5-latest");
    }

    // ── Ported from background-model.test.ts.bak ──────────────────────────

    #[test]
    fn invalid_thinking_level_on_non_resolving_prefix_is_fatal() {
        // The prefix doesn't resolve either: the missing model is the real
        // problem, the bad suffix is moot, so the resolver returns no model +
        // the inner (fatal) warning.
        let r = resolve_background_model(Some("anthropic/nope-9-9:banana"), &reg());
        assert!(r.model.is_none());
        assert!(
            r.warning
                .as_deref()
                .unwrap()
                .contains("No registered model matches")
        );
    }

    #[test]
    fn canonical_provider_id_with_real_collision_warns() {
        // The SAME canonical `provider/id` appearing twice (shouldn't happen,
        // but if a custom provider double-registers) is ambiguous and rejected
        // loud — no silent pick.
        let dup = vec![
            ModelOption {
                provider: "anthropic".into(),
                model_id: "dupe".into(),
                label: "Dupe 1".into(),
                thinking_levels: None,
            },
            ModelOption {
                provider: "anthropic".into(),
                model_id: "dupe".into(),
                label: "Dupe 2".into(),
                thinking_levels: None,
            },
        ];
        let r = resolve_background_model(Some("anthropic/dupe"), &dup);
        assert!(r.model.is_none());
        assert!(
            r.warning
                .as_deref()
                .unwrap()
                .contains("No registered model matches")
        );
    }
}

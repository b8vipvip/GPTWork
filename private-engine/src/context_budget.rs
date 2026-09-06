use serde::{Deserialize, Serialize};

const DEFAULT_CONTEXT_WINDOW_TOKENS: u64 = 128_000;
const SAFETY_BUDGET_RATIO: f64 = 0.88;
const HARD_LIMIT_SANITY_RATIO: f64 = 0.25;
const HARD_LIMIT_SANITY_MIN_TOKENS: u64 = 32_000;
const WARNING_PERCENT: f64 = 80.0;
const MAX_DISPLAY_PERCENT: f64 = 999.0;
const MESSAGE_OVERHEAD_TOKENS: u64 = 14;
const IMAGE_TOKEN_ESTIMATE: u64 = 1_200;
const ATTACHMENT_TOKEN_ESTIMATE: u64 = 4_000;
const MAX_INPUT_TEXT_CHARS: usize = 16 * 1024 * 1024;
const MAX_HISTORY_PARTS: usize = 20_000;
const MAX_ADAPTIVE_LIMIT_TOKENS: u64 = 16_000_000;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextTextPart {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub images: u32,
    #[serde(default)]
    pub attachments: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetProfile {
    pub adaptive_safe_limit_tokens: Option<u64>,
    pub hard_limit_upper_bound_tokens: Option<u64>,
    pub confirmed_conversation_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetInput {
    pub model: Option<String>,
    #[serde(default)]
    pub history: Vec<ContextTextPart>,
    #[serde(default)]
    pub draft: ContextTextPart,
    #[serde(default)]
    pub profile: ContextBudgetProfile,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudgetResult {
    pub nominal_limit_tokens: u64,
    pub base_safe_limit_tokens: u64,
    pub adaptive_safe_limit_tokens: u64,
    pub hard_limit_upper_bound_tokens: u64,
    pub confirmed_lower_bound_tokens: u64,
    pub safe_limit_tokens: u64,
    pub reserve_tokens: u64,
    pub history_tokens: u64,
    pub draft_tokens: u64,
    pub used_tokens: u64,
    pub projected_tokens: u64,
    pub percent_used: f64,
    pub projected_percent: f64,
    pub remaining_percent: f64,
    pub remaining_tokens: u64,
    pub warning: bool,
    pub would_exceed: bool,
    pub adaptive_active: bool,
    pub hard_limit_active: bool,
    pub context_window_source: String,
}

fn clamp_metric(value: Option<u64>) -> u64 {
    value.unwrap_or_default().min(MAX_ADAPTIVE_LIMIT_TOKENS)
}

fn normalize_model(value: Option<&str>) -> Option<String> {
    let value = value?.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
    }) {
        return None;
    }
    Some(match value.as_str() {
        "gpt-5.6-sol-wm" | "gpt-5-6" | "gpt-5-6-thinking" => "gpt-5.6-sol".to_string(),
        _ => value,
    })
}

fn matches_model_family(model: &str, family: &str) -> bool {
    model == family
        || model
            .strip_prefix(family)
            .map(|suffix| suffix.starts_with('-'))
            .unwrap_or(false)
}

fn model_window(model: Option<&str>) -> (u64, &'static str) {
    let Some(model) = normalize_model(model) else {
        return (DEFAULT_CONTEXT_WINDOW_TOKENS, "conservative-fallback");
    };
    if matches_model_family(&model, "gpt-5.4-mini") || matches_model_family(&model, "gpt-5.4-nano")
    {
        return (400_000, "model-window");
    }
    if matches_model_family(&model, "gpt-5.6")
        || matches_model_family(&model, "gpt-5.5")
        || matches_model_family(&model, "gpt-5.4")
    {
        return (1_050_000, "model-window");
    }
    (DEFAULT_CONTEXT_WINDOW_TOKENS, "conservative-fallback")
}

pub(crate) fn base_safe_limit_for_model(model: Option<&str>) -> u64 {
    let (nominal, _) = model_window(model);
    (nominal.max(16_000) as f64 * SAFETY_BUDGET_RATIO).floor() as u64
}

pub(crate) fn hard_limit_sanity_floor_for_model(model: Option<&str>) -> u64 {
    ((base_safe_limit_for_model(model) as f64 * HARD_LIMIT_SANITY_RATIO).floor() as u64)
        .max(HARD_LIMIT_SANITY_MIN_TOKENS)
}

fn estimate_text_tokens(value: &str) -> u64 {
    if value.is_empty() {
        return 0;
    }
    let mut cjk = 0_u64;
    let mut ascii = 0_u64;
    let mut emoji = 0_u64;
    let mut other = 0_u64;
    let mut line_breaks = 0_u64;

    for character in value.chars() {
        let code = character as u32;
        if character == '\n' {
            line_breaks += 1;
        }
        if (0x3400..=0x9fff).contains(&code)
            || (0x3040..=0x30ff).contains(&code)
            || (0xac00..=0xd7af).contains(&code)
        {
            cjk += 1;
        } else if (0x1f000..=0x1faff).contains(&code) || (0x2600..=0x27bf).contains(&code) {
            emoji += 1;
        } else if code <= 0x7f {
            ascii += 1;
        } else if !character.is_whitespace() {
            other += 1;
        }
    }

    let estimate = (cjk as f64 * 1.12)
        + (ascii as f64 / 3.65)
        + (emoji as f64 * 2.2)
        + (other as f64 * 1.35)
        + (line_breaks as f64 * 0.18);
    estimate.ceil().max(1.0) as u64
}

fn part_tokens(part: &ContextTextPart, include_message_overhead: bool) -> u64 {
    let images = u64::from(part.images.min(32));
    let attachments = u64::from(part.attachments.min(32));
    let content = estimate_text_tokens(&part.text)
        .saturating_add(images.saturating_mul(IMAGE_TOKEN_ESTIMATE))
        .saturating_add(attachments.saturating_mul(ATTACHMENT_TOKEN_ESTIMATE));
    if include_message_overhead && (!part.text.is_empty() || images > 0 || attachments > 0) {
        content.saturating_add(MESSAGE_OVERHEAD_TOKENS)
    } else {
        content
    }
}

fn reserve_tokens(context_limit_tokens: u64) -> u64 {
    ((context_limit_tokens as f64 * 0.04).round() as u64).clamp(8_192, 64_000)
}

fn validate_input(input: &ContextBudgetInput) -> Result<(), String> {
    if input.history.len() > MAX_HISTORY_PARTS {
        return Err("context history contains too many parts".to_string());
    }
    let total_chars = input
        .history
        .iter()
        .map(|part| part.text.chars().count())
        .chain(std::iter::once(input.draft.text.chars().count()))
        .try_fold(0_usize, |total, count| total.checked_add(count).ok_or(()))
        .map_err(|_| "context text size overflow".to_string())?;
    if total_chars > MAX_INPUT_TEXT_CHARS {
        return Err("context text exceeds local evaluation limit".to_string());
    }
    Ok(())
}

pub fn evaluate_context_budget(input: &ContextBudgetInput) -> Result<ContextBudgetResult, String> {
    validate_input(input)?;
    let (nominal_limit_tokens, context_window_source) = model_window(input.model.as_deref());
    let nominal_limit_tokens = nominal_limit_tokens.max(16_000);
    let base_safe_limit_tokens = base_safe_limit_for_model(input.model.as_deref());
    let adaptive_safe_limit_tokens = clamp_metric(input.profile.adaptive_safe_limit_tokens);
    let confirmed_lower_bound_tokens = clamp_metric(input.profile.confirmed_conversation_tokens);
    let stored_hard_limit_upper_bound_tokens = clamp_metric(input.profile.hard_limit_upper_bound_tokens);

    let history_tokens = input.history.iter().fold(0_u64, |total, part| {
        total.saturating_add(part_tokens(part, true))
    });
    let draft_tokens = part_tokens(&input.draft, !input.draft.text.trim().is_empty());
    let used_tokens = history_tokens.saturating_add(draft_tokens);

    let hard_limit_floor = hard_limit_sanity_floor_for_model(input.model.as_deref());
    let hard_limit_usable = stored_hard_limit_upper_bound_tokens > confirmed_lower_bound_tokens
        && stored_hard_limit_upper_bound_tokens >= hard_limit_floor
        // Existing conversation history beyond the learned upper bound is direct
        // evidence that the stored upper bound was stale or falsely learned.
        && history_tokens <= stored_hard_limit_upper_bound_tokens;
    let hard_limit_upper_bound_tokens = if hard_limit_usable {
        stored_hard_limit_upper_bound_tokens
    } else {
        0
    };

    let unconstrained_safe_limit_tokens = base_safe_limit_tokens.max(adaptive_safe_limit_tokens);
    let safe_limit_tokens = if hard_limit_usable {
        unconstrained_safe_limit_tokens
            .min(hard_limit_upper_bound_tokens)
            .max(confirmed_lower_bound_tokens)
            .max(16_000)
    } else {
        unconstrained_safe_limit_tokens
    };
    let reserve_basis = if hard_limit_usable {
        safe_limit_tokens
    } else {
        nominal_limit_tokens.max(safe_limit_tokens)
    };
    let reserve_tokens = reserve_tokens(reserve_basis);

    let projected_tokens = used_tokens.saturating_add(reserve_tokens);
    let remaining_tokens = safe_limit_tokens.saturating_sub(used_tokens);
    let percent_used =
        ((used_tokens as f64 / safe_limit_tokens as f64) * 100.0).min(MAX_DISPLAY_PERCENT);
    let projected_percent =
        ((projected_tokens as f64 / safe_limit_tokens as f64) * 100.0).min(MAX_DISPLAY_PERCENT);
    let remaining_percent =
        ((remaining_tokens as f64 / safe_limit_tokens as f64) * 100.0).clamp(0.0, 100.0);

    Ok(ContextBudgetResult {
        nominal_limit_tokens,
        base_safe_limit_tokens,
        adaptive_safe_limit_tokens,
        hard_limit_upper_bound_tokens,
        confirmed_lower_bound_tokens,
        safe_limit_tokens,
        reserve_tokens,
        history_tokens,
        draft_tokens,
        used_tokens,
        projected_tokens,
        percent_used,
        projected_percent,
        remaining_percent,
        remaining_tokens,
        warning: percent_used >= WARNING_PERCENT,
        would_exceed: projected_tokens >= safe_limit_tokens,
        adaptive_active: adaptive_safe_limit_tokens > base_safe_limit_tokens,
        hard_limit_active: hard_limit_usable && safe_limit_tokens <= hard_limit_upper_bound_tokens,
        context_window_source: context_window_source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_window_and_token_estimator_stay_inside_private_engine() {
        let result = evaluate_context_budget(&ContextBudgetInput {
            model: Some("gpt-5.6-sol".to_string()),
            history: vec![ContextTextPart {
                text: "hello world".to_string(),
                ..Default::default()
            }],
            draft: ContextTextPart {
                text: "你好".to_string(),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.nominal_limit_tokens, 1_050_000);
        assert_eq!(result.base_safe_limit_tokens, 924_000);
        assert!(result.history_tokens > MESSAGE_OVERHEAD_TOKENS);
        assert!(result.draft_tokens > 0);
        assert!(result.remaining_percent > 90.0);
    }

    #[test]
    fn web_thinking_alias_uses_the_same_gpt_56_window() {
        let result = evaluate_context_budget(&ContextBudgetInput {
            model: Some("gpt-5-6-thinking".to_string()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.nominal_limit_tokens, 1_050_000);
        assert_eq!(result.base_safe_limit_tokens, 924_000);
    }

    #[test]
    fn narrower_model_family_matching_does_not_capture_lookalike_prefixes() {
        let result = evaluate_context_budget(&ContextBudgetInput {
            model: Some("gpt-5.4-minimum".to_string()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.nominal_limit_tokens, 1_050_000);
        assert_eq!(result.context_window_source, "model-window");
    }

    #[test]
    fn learned_upper_bound_caps_operational_budget() {
        let result = evaluate_context_budget(&ContextBudgetInput {
            model: Some("gpt-5.6-sol".to_string()),
            profile: ContextBudgetProfile {
                adaptive_safe_limit_tokens: Some(1_200_000),
                hard_limit_upper_bound_tokens: Some(950_000),
                confirmed_conversation_tokens: Some(900_000),
            },
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.safe_limit_tokens, 950_000);
        assert_eq!(result.hard_limit_upper_bound_tokens, 950_000);
        assert!(result.hard_limit_active);
    }

    #[test]
    fn implausibly_small_persisted_hard_limit_self_heals() {
        let result = evaluate_context_budget(&ContextBudgetInput {
            model: Some("gpt-5.6-sol".to_string()),
            profile: ContextBudgetProfile {
                hard_limit_upper_bound_tokens: Some(9_654),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
        assert_eq!(hard_limit_sanity_floor_for_model(Some("gpt-5.6-sol")), 231_000);
        assert_eq!(result.hard_limit_upper_bound_tokens, 0);
        assert_eq!(result.safe_limit_tokens, 924_000);
        assert!(!result.hard_limit_active);
    }

    #[test]
    fn learned_upper_bound_is_ignored_after_history_proves_it_wrong() {
        let result = evaluate_context_budget(&ContextBudgetInput {
            model: Some("gpt-5.6-sol".to_string()),
            history: vec![ContextTextPart {
                text: "x".repeat(1_100_000),
                ..Default::default()
            }],
            profile: ContextBudgetProfile {
                hard_limit_upper_bound_tokens: Some(250_000),
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
        assert!(result.history_tokens > 250_000);
        assert_eq!(result.hard_limit_upper_bound_tokens, 0);
        assert_eq!(result.safe_limit_tokens, 924_000);
        assert!(!result.hard_limit_active);
    }

    #[test]
    fn oversized_text_is_rejected_before_evaluation() {
        let input = ContextBudgetInput {
            history: vec![ContextTextPart {
                text: "x".repeat(MAX_INPUT_TEXT_CHARS + 1),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(evaluate_context_budget(&input).is_err());
    }
}

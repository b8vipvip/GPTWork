use serde::{Deserialize, Serialize};

use crate::context_budget::{base_safe_limit_for_model, hard_limit_sanity_floor_for_model};

const LEARNING_HEADROOM_RATIO: f64 = 0.06;
const LEARNING_HEADROOM_MIN_TOKENS: u64 = 8_192;
const LEARNING_HEADROOM_MAX_TOKENS: u64 = 128_000;
const MAX_ADAPTIVE_LIMIT_TOKENS: u64 = 16_000_000;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextProfileNumbers {
    pub confirmed_conversation_tokens: Option<u64>,
    pub confirmed_characters: Option<u64>,
    pub adaptive_safe_limit_tokens: Option<u64>,
    pub successful_bypass_count: Option<u64>,
    pub hard_limit_upper_bound_tokens: Option<u64>,
    pub hard_limit_observed_count: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContextProfileEvaluationInput {
    pub event: String,
    pub model: Option<String>,
    #[serde(default)]
    pub previous: ContextProfileNumbers,
    pub confirmed_conversation_tokens: Option<u64>,
    pub confirmed_characters: Option<u64>,
    pub observed_conversation_tokens: Option<u64>,
    #[serde(default)]
    pub measurement_reliable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextProfileEvaluationResult {
    pub confirmed_conversation_tokens: u64,
    pub confirmed_characters: u64,
    pub adaptive_safe_limit_tokens: u64,
    pub successful_bypass_count: u64,
    pub hard_limit_upper_bound_tokens: u64,
    pub hard_limit_observed_count: u64,
    pub hard_limit_token_cap_usable: bool,
    pub hard_limit_confidence: String,
}

fn clamp_metric(value: Option<u64>) -> u64 {
    value.unwrap_or_default().min(MAX_ADAPTIVE_LIMIT_TOKENS)
}

fn learning_headroom_tokens(confirmed: u64) -> u64 {
    ((confirmed as f64 * LEARNING_HEADROOM_RATIO).round() as u64)
        .clamp(LEARNING_HEADROOM_MIN_TOKENS, LEARNING_HEADROOM_MAX_TOKENS)
}

pub fn evaluate_context_profile(
    input: &ContextProfileEvaluationInput,
) -> Result<ContextProfileEvaluationResult, String> {
    let mut confirmed = clamp_metric(input.previous.confirmed_conversation_tokens);
    let mut confirmed_characters = input.previous.confirmed_characters.unwrap_or_default();
    let mut adaptive = clamp_metric(input.previous.adaptive_safe_limit_tokens);
    let mut successful_count = input.previous.successful_bypass_count.unwrap_or_default();

    // Migrate old polluted profile data in-place. A hard upper below the model's
    // plausibility floor (or already below a proven successful lower bound) must
    // not survive merely because it was persisted by an older build.
    let sanity_floor = hard_limit_sanity_floor_for_model(input.model.as_deref());
    let previous_hard_upper = clamp_metric(input.previous.hard_limit_upper_bound_tokens);
    let previous_hard_valid = previous_hard_upper >= sanity_floor && previous_hard_upper > confirmed;
    let mut hard_upper = if previous_hard_valid { previous_hard_upper } else { 0 };
    let mut hard_count = if previous_hard_valid {
        input.previous.hard_limit_observed_count.unwrap_or_default()
    } else {
        0
    };
    let mut hard_confidence = if hard_upper > confirmed {
        "measured-upper-bound"
    } else {
        "ui-boundary-only"
    };

    match input.event.as_str() {
        "successful_bypass" => {
            let observed = clamp_metric(input.confirmed_conversation_tokens);
            if observed == 0 {
                return Err("successful bypass requires confirmedConversationTokens".to_string());
            }
            confirmed = confirmed.max(observed);
            confirmed_characters =
                confirmed_characters.max(input.confirmed_characters.unwrap_or_default());
            let candidate = confirmed.saturating_add(learning_headroom_tokens(confirmed));
            adaptive = adaptive
                .max(candidate.min(MAX_ADAPTIVE_LIMIT_TOKENS))
                .max(base_safe_limit_for_model(input.model.as_deref()));
            successful_count = successful_count.saturating_add(1);
            if hard_upper <= confirmed {
                hard_upper = 0;
                hard_count = 0;
                hard_confidence = "ui-boundary-only";
            }
        }
        "hard_limit" => {
            let observed = clamp_metric(input.observed_conversation_tokens);
            let usable = input.measurement_reliable
                && observed > confirmed
                && observed >= sanity_floor;
            if usable {
                let next_upper = if hard_upper > confirmed {
                    hard_upper.min(observed)
                } else {
                    observed
                };
                // Repeated refreshes of the same on-screen notice must not be
                // counted as new learning unless they actually tighten the bound.
                if hard_upper == 0 || next_upper < hard_upper {
                    hard_count = hard_count.saturating_add(1);
                }
                hard_upper = next_upper;
                hard_confidence = "measured-upper-bound";
            } else {
                hard_confidence = if hard_upper > confirmed {
                    "measured-upper-bound"
                } else {
                    "ui-boundary-only"
                };
            }
        }
        _ => return Err("unsupported context profile event".to_string()),
    }

    Ok(ContextProfileEvaluationResult {
        confirmed_conversation_tokens: confirmed,
        confirmed_characters,
        adaptive_safe_limit_tokens: adaptive,
        successful_bypass_count: successful_count,
        hard_limit_upper_bound_tokens: hard_upper,
        hard_limit_observed_count: hard_count,
        hard_limit_token_cap_usable: hard_upper > confirmed,
        hard_limit_confidence: hard_confidence.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_bypass_derives_adaptive_budget_privately() {
        let result = evaluate_context_profile(&ContextProfileEvaluationInput {
            event: "successful_bypass".to_string(),
            model: Some("gpt-5.6-sol".to_string()),
            confirmed_conversation_tokens: Some(950_000),
            confirmed_characters: Some(3_000_000),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.confirmed_conversation_tokens, 950_000);
        assert_eq!(result.adaptive_safe_limit_tokens, 1_007_000);
        assert_eq!(result.successful_bypass_count, 1);
    }

    #[test]
    fn reliable_hard_limit_tightens_only_above_confirmed_lower_bound() {
        let result = evaluate_context_profile(&ContextProfileEvaluationInput {
            event: "hard_limit".to_string(),
            model: Some("gpt-5.6-sol".to_string()),
            previous: ContextProfileNumbers {
                confirmed_conversation_tokens: Some(900_000),
                hard_limit_upper_bound_tokens: Some(1_000_000),
                hard_limit_observed_count: Some(2),
                ..Default::default()
            },
            observed_conversation_tokens: Some(960_000),
            measurement_reliable: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.hard_limit_upper_bound_tokens, 960_000);
        assert!(result.hard_limit_token_cap_usable);
        assert_eq!(result.hard_limit_observed_count, 3);
        assert_eq!(result.hard_limit_confidence, "measured-upper-bound");
    }

    #[test]
    fn unreliable_hard_limit_does_not_create_a_numeric_cap() {
        let result = evaluate_context_profile(&ContextProfileEvaluationInput {
            event: "hard_limit".to_string(),
            model: Some("gpt-5.6-sol".to_string()),
            observed_conversation_tokens: Some(500_000),
            measurement_reliable: false,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.hard_limit_upper_bound_tokens, 0);
        assert_eq!(result.hard_limit_observed_count, 0);
        assert!(!result.hard_limit_token_cap_usable);
        assert_eq!(result.hard_limit_confidence, "ui-boundary-only");
    }

    #[test]
    fn implausibly_small_reliable_limit_is_rejected_and_old_pollution_is_migrated() {
        let result = evaluate_context_profile(&ContextProfileEvaluationInput {
            event: "hard_limit".to_string(),
            model: Some("gpt-5.6-sol".to_string()),
            previous: ContextProfileNumbers {
                hard_limit_upper_bound_tokens: Some(9_654),
                hard_limit_observed_count: Some(8),
                ..Default::default()
            },
            observed_conversation_tokens: Some(10_000),
            measurement_reliable: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.hard_limit_upper_bound_tokens, 0);
        assert_eq!(result.hard_limit_observed_count, 0);
        assert!(!result.hard_limit_token_cap_usable);
    }

    #[test]
    fn repeated_same_hard_limit_refresh_does_not_inflate_observation_count() {
        let result = evaluate_context_profile(&ContextProfileEvaluationInput {
            event: "hard_limit".to_string(),
            model: Some("gpt-5.6-sol".to_string()),
            previous: ContextProfileNumbers {
                hard_limit_upper_bound_tokens: Some(950_000),
                hard_limit_observed_count: Some(3),
                ..Default::default()
            },
            observed_conversation_tokens: Some(970_000),
            measurement_reliable: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(result.hard_limit_upper_bound_tokens, 950_000);
        assert_eq!(result.hard_limit_observed_count, 3);
    }
}

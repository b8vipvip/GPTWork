use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::config::{normalize_model_id, normalize_reasoning_level, Policy};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    NetworkResponseMetadata,
    ConversationResponseMetadata,
    NetworkRequestMetadata,
    PageDom,
    UserSelection,
    #[default]
    Unknown,
}

impl EvidenceSource {
    fn is_sufficient(self) -> bool {
        matches!(
            self,
            Self::NetworkResponseMetadata | Self::ConversationResponseMetadata
        )
    }

    fn confidence(self) -> Confidence {
        match self {
            Self::NetworkResponseMetadata => Confidence::High,
            Self::ConversationResponseMetadata => Confidence::Medium,
            Self::NetworkRequestMetadata | Self::PageDom | Self::UserSelection => Confidence::Low,
            Self::Unknown => Confidence::None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationRequest {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default, alias = "source")]
    pub evidence_source: EvidenceSource,
    #[serde(default)]
    pub captured_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Verified,
    Mismatch,
    Unverified,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    Block,
    Warn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasonCode {
    ModelMissing,
    ModelNotAllowed,
    ReasoningMissing,
    ReasoningNotAllowed,
    EvidenceSourceInsufficient,
    EvidenceStale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub allowed: bool,
    pub verdict: Verdict,
    pub decision: PolicyDecision,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub evidence_source: EvidenceSource,
    pub confidence: Confidence,
    pub reason: Option<ReasonCode>,
    pub reasons: Vec<ReasonCode>,
    pub policy_revision: String,
    pub request_id: Option<String>,
    pub verified_at: DateTime<Utc>,
}

fn canonical_model_id(value: &str) -> Option<String> {
    let normalized = normalize_model_id(value).ok()?;
    if normalized == "gpt-5.6-sol-wm" {
        return Some("gpt-5.6-sol".to_owned());
    }
    if normalized == "gpt-6-astra"
        || normalized.starts_with("gpt-6-astra-")
        || normalized.starts_with("gpt-6-astra_")
        || normalized.starts_with("gpt-6-astra.")
        || normalized.starts_with("gpt-6-astra:")
    {
        return Some("gpt-6-astra".to_owned());
    }
    Some(normalized)
}

// A plain GPT version and its explicit -thinking protocol sibling share
// authorization identity. Other model tiers remain distinct. Importantly,
// VerificationResult.model retains the actual canonical response identity.
fn model_lock_family(model: &str) -> &str {
    if let Some(versioned) = model.strip_suffix("-thinking") {
        if let Some(version) = versioned.strip_prefix("gpt-") {
            if !version.is_empty()
                && version.split('.').all(|segment| {
                    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_digit())
                })
            {
                return versioned;
            }
        }
    }
    model
}

fn policy_allows_model(policy: &Policy, model: &str) -> bool {
    policy
        .locked_models
        .iter()
        .filter_map(|value| canonical_model_id(value))
        .any(|allowed| model_lock_family(&allowed) == model_lock_family(model))
}

pub fn verify(
    policy: &Policy,
    policy_revision: &str,
    request: VerificationRequest,
) -> VerificationResult {
    let now = Utc::now();
    let request_id = request.request_id.as_deref().and_then(normalize_request_id);
    let model = request.model.as_deref().and_then(canonical_model_id);
    let reasoning = request
        .reasoning
        .as_deref()
        .and_then(|value| normalize_reasoning_level(value).ok());
    let mut reasons = Vec::new();
    let mut mismatch = false;

    match model.as_ref() {
        None => reasons.push(ReasonCode::ModelMissing),
        Some(model) if !policy_allows_model(policy, model) => {
            mismatch = true;
            reasons.push(ReasonCode::ModelNotAllowed);
        }
        Some(_) => {}
    }

    match reasoning.as_ref() {
        None => reasons.push(ReasonCode::ReasoningMissing),
        Some(reasoning) if !policy.allowed_reasoning_levels.contains(reasoning) => {
            mismatch = true;
            reasons.push(ReasonCode::ReasoningNotAllowed);
        }
        Some(_) => {}
    }

    if !request.evidence_source.is_sufficient() {
        reasons.push(ReasonCode::EvidenceSourceInsufficient);
    }

    if let Some(captured_at) = request.captured_at {
        if captured_at < now - Duration::minutes(5) || captured_at > now + Duration::minutes(1) {
            reasons.push(ReasonCode::EvidenceStale);
        }
    }

    let verdict = if mismatch {
        Verdict::Mismatch
    } else if reasons.is_empty() {
        Verdict::Verified
    } else {
        Verdict::Unverified
    };

    let confirmed_model_mismatch = reasons.contains(&ReasonCode::ModelNotAllowed);
    let decision = match verdict {
        Verdict::Verified => PolicyDecision::Allow,
        _ if policy.strict_mode && confirmed_model_mismatch => PolicyDecision::Block,
        _ => PolicyDecision::Warn,
    };

    VerificationResult {
        allowed: decision != PolicyDecision::Block,
        verdict,
        decision,
        model,
        reasoning,
        evidence_source: request.evidence_source,
        confidence: request.evidence_source.confidence(),
        reason: reasons.first().copied(),
        reasons,
        policy_revision: policy_revision.to_owned(),
        request_id,
        verified_at: now,
    }
}

fn normalize_request_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        None
    } else {
        Some(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(source: EvidenceSource, model: &str, reasoning: &str) -> VerificationRequest {
        VerificationRequest {
            model: Some(model.to_owned()),
            reasoning: Some(reasoning.to_owned()),
            evidence_source: source,
            captured_at: Some(Utc::now()),
            request_id: Some("test-request".to_owned()),
        }
    }

    fn astra_policy() -> Policy {
        Policy {
            locked_models: vec!["gpt-6-astra".to_owned(), "gpt-5.6-sol".to_owned()],
            ..Policy::default()
        }
    }

    #[test]
    fn verifies_matching_network_metadata() {
        let result = verify(
            &Policy::default(),
            "revision",
            request(
                EvidenceSource::NetworkResponseMetadata,
                "gpt-5.6-sol",
                "high",
            ),
        );
        assert_eq!(result.verdict, Verdict::Verified);
        assert_eq!(result.decision, PolicyDecision::Allow);
        assert!(result.allowed);
    }

    #[test]
    fn verifies_astra_family_transport_without_guessing_exact_suffix() {
        for model in ["gpt-6-astra", "gpt-6-astra-wm", "gpt-6-astra.preview"] {
            let result = verify(
                &astra_policy(),
                "revision",
                request(EvidenceSource::NetworkResponseMetadata, model, "high"),
            );
            assert_eq!(result.model.as_deref(), Some("gpt-6-astra"));
            assert_eq!(result.verdict, Verdict::Verified);
            assert_eq!(result.decision, PolicyDecision::Allow);
        }
    }

    #[test]
    fn page_text_is_never_promoted_to_backend_proof() {
        let result = verify(
            &Policy::default(),
            "revision",
            request(EvidenceSource::PageDom, "gpt-5.6-sol", "high"),
        );
        assert_eq!(result.verdict, Verdict::Unverified);
        assert_eq!(result.decision, PolicyDecision::Warn);
        assert!(result.allowed);
        assert!(result
            .reasons
            .contains(&ReasonCode::EvidenceSourceInsufficient));
    }

    #[test]
    fn request_metadata_is_preflight_only() {
        let result = verify(
            &Policy::default(),
            "revision",
            request(
                EvidenceSource::NetworkRequestMetadata,
                "gpt-5.6-sol",
                "high",
            ),
        );
        assert_eq!(result.verdict, Verdict::Unverified);
        assert_eq!(result.decision, PolicyDecision::Warn);
        assert!(result.allowed);
    }

    #[test]
    fn strict_mode_blocks_confirmed_model_mismatch() {
        let result = verify(
            &Policy::default(),
            "revision",
            request(EvidenceSource::NetworkResponseMetadata, "gpt-5.5", "high"),
        );
        assert_eq!(result.verdict, Verdict::Mismatch);
        assert_eq!(result.decision, PolicyDecision::Block);
        assert!(!result.allowed);
    }

    #[test]
    fn reminder_mode_warns_but_does_not_block() {
        let policy = Policy {
            strict_mode: false,
            ..Policy::default()
        };
        let result = verify(
            &policy,
            "revision",
            request(EvidenceSource::NetworkResponseMetadata, "gpt-5.5", "high"),
        );
        assert_eq!(result.decision, PolicyDecision::Warn);
        assert!(result.allowed);
    }

    #[test]
    fn drops_unsafe_request_ids_from_audit_result() {
        let mut request = request(
            EvidenceSource::NetworkResponseMetadata,
            "gpt-5.6-sol",
            "high",
        );
        request.request_id = Some("contains spaces and personal text".to_owned());
        let result = verify(&Policy::default(), "revision", request);
        assert_eq!(result.request_id, None);
    }

    #[test]
    fn strict_mode_warns_when_response_metadata_is_incomplete() {
        let mut incomplete = request(
            EvidenceSource::NetworkResponseMetadata,
            "gpt-5.6-sol",
            "high",
        );
        incomplete.reasoning = None;
        let result = verify(&Policy::default(), "revision", incomplete);
        assert_eq!(result.verdict, Verdict::Unverified);
        assert_eq!(result.decision, PolicyDecision::Warn);
        assert!(result.allowed);
    }

    #[test]
    fn strict_mode_warns_on_reasoning_only_mismatch() {
        let result = verify(
            &Policy::default(),
            "revision",
            request(
                EvidenceSource::NetworkResponseMetadata,
                "gpt-5.6-sol",
                "low",
            ),
        );
        assert_eq!(result.verdict, Verdict::Mismatch);
        assert_eq!(result.decision, PolicyDecision::Warn);
        assert!(result.allowed);
        assert_eq!(result.reason, Some(ReasonCode::ReasoningNotAllowed));
    }

    #[test]
    fn base_gpt_and_thinking_protocol_models_share_lock_identity_but_keep_real_response() {
        for (base, thinking) in [
            ("gpt-6", "gpt-6-thinking"),
            ("gpt-6.5", "gpt-6.5-thinking"),
            ("gpt-7", "gpt-7-thinking"),
        ] {
            let policy = Policy {
                locked_models: vec![base.to_owned()],
                allowed_reasoning_levels: vec!["high".to_owned()],
                strict_mode: true,
            };
            let result = verify(
                &policy,
                "revision",
                request(EvidenceSource::NetworkResponseMetadata, thinking, "high"),
            );
            assert_eq!(result.verdict, Verdict::Verified, "{base}");
            assert_eq!(result.model.as_deref(), Some(thinking));

            let reverse = Policy {
                locked_models: vec![thinking.to_owned()],
                ..policy
            };
            assert_eq!(
                verify(
                    &reverse,
                    "revision",
                    request(EvidenceSource::NetworkResponseMetadata, base, "high"),
                )
                .verdict,
                Verdict::Verified
            );
        }
    }

    #[test]
    fn different_gpt_generations_and_other_tiers_do_not_match_thinking_family() {
        let policy = Policy {
            locked_models: vec!["gpt-6".to_owned()],
            allowed_reasoning_levels: vec!["high".to_owned()],
            strict_mode: true,
        };
        for observed in [
            "gpt-6.5-thinking",
            "gpt-7-thinking",
            "gpt-6-sol",
            "gpt-6-astra",
            "gpt-6-instant",
            "gpt-6-thinking-extra",
        ] {
            let result = verify(
                &policy,
                "revision",
                request(EvidenceSource::NetworkResponseMetadata, observed, "high"),
            );
            assert_eq!(result.verdict, Verdict::Mismatch, "{observed}");
            assert_eq!(result.model.as_deref(), Some(observed));
        }
    }

    #[test]
    fn sol_transport_alias_matches_canonical_policy() {
        let result = verify(
            &Policy::default(),
            "revision",
            request(
                EvidenceSource::NetworkResponseMetadata,
                "gpt-5.6-sol-wm",
                "high",
            ),
        );
        assert_eq!(result.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(result.verdict, Verdict::Verified);
    }
}

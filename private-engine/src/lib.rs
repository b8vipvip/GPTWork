use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_WALK_DEPTH: usize = 14;
const MAX_BODY_CHARS: usize = 16 * 1024 * 1024;
const OFFICIAL_CONVERSATION_PATHS: [&str; 2] =
    ["/backend-api/conversation", "/backend-api/f/conversation"];
const MODEL_KEYS: [&str; 16] = [
    "model_slug",
    "modelslug",
    "model_id",
    "modelid",
    "used_model",
    "resolved_model",
    "resolved_model_slug",
    "served_model",
    "served_model_slug",
    "used_model_slug",
    "default_model_slug",
    "model_name",
    "modelname",
    "backend_model",
    "backend_model_slug",
    "model",
];
const REASONING_KEYS: [&str; 7] = [
    "reasoning_effort",
    "reasoningeffort",
    "reasoning_level",
    "reasoninglevel",
    "thinking_level",
    "thinkinglevel",
    "thinking_effort",
];
const SKIPPED_CONTENT_KEYS: [&str; 7] = [
    "content",
    "parts",
    "text",
    "prompt",
    "input",
    "output_text",
    "arguments",
];
const MODEL_HEADERS: [&str; 4] = ["x-openai-model", "openai-model", "x-gpt-model", "x-model"];
const REASONING_HEADERS: [&str; 3] = [
    "x-openai-reasoning-effort",
    "x-reasoning-effort",
    "x-reasoning-level",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub host: String,
    pub path: String,
    pub method: String,
    pub post_data: String,
    #[serde(default)]
    pub locked_models: Vec<String>,
    #[serde(default)]
    pub allowed_reasoning_levels: Vec<String>,
    pub preferred_reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestDecision {
    pub official_conversation: bool,
    pub changed: bool,
    pub reason: String,
    pub post_data: String,
    pub model_before: Option<String>,
    pub model_after: Option<String>,
    pub transport_model_before: Option<String>,
    pub transport_model_after: Option<String>,
    pub reasoning_before: Option<String>,
    pub reasoning_after: Option<String>,
    pub reasoning_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceConflicts {
    pub model: bool,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceFields {
    pub model: Option<String>,
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceDiagnostics {
    pub body_length: usize,
    pub body_format: String,
    pub parsed_object_count: usize,
    pub model_candidate_count: usize,
    pub reasoning_candidate_count: usize,
    pub matched_header_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceResult {
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub conflicts: EvidenceConflicts,
    pub fields: EvidenceFields,
    pub evidence_source: String,
    pub diagnostics: EvidenceDiagnostics,
}

#[derive(Debug, Clone)]
struct Candidate {
    value: String,
    score: i32,
    path: String,
}

#[derive(Debug, Clone, Default)]
struct CandidateSet {
    model: Vec<Candidate>,
    reasoning: Vec<Candidate>,
}

#[derive(Debug, Clone, Default)]
struct Selection {
    value: Option<String>,
    conflict: bool,
    path: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct BodyInspection {
    values: Vec<Value>,
    body_length: usize,
    body_format: String,
}

fn canonical_key(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['-', '.'], "_")
}

fn valid_model_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
}

pub fn normalize_model_id(value: &str) -> Option<String> {
    let model = value.trim().to_ascii_lowercase();
    if model.is_empty() || model.len() > 128 || !model.chars().all(valid_model_char) {
        return None;
    }
    Some(match model.as_str() {
        "gpt-5.6-sol-wm" | "gpt-5-6" => "gpt-5.6-sol".to_string(),
        "gpt-6-astra-wm" => "gpt-6-astra".to_string(),
        "gpt-6-sol-wm" => "gpt-6-sol".to_string(),
        _ if model.starts_with("gpt-6-astra.") || model.starts_with("gpt-6-astra:") => {
            "gpt-6-astra".to_string()
        }
        _ if model.starts_with("gpt-6-sol.") || model.starts_with("gpt-6-sol:") => {
            "gpt-6-sol".to_string()
        }
        _ => model,
    })
}

pub fn model_transport_id(value: &str) -> Option<String> {
    let model = normalize_model_id(value)?;
    Some(match model.as_str() {
        "gpt-5.6-sol" => "gpt-5.6-sol-wm".to_string(),
        "gpt-6-astra" => "gpt-6-astra-wm".to_string(),
        "gpt-6-sol" => "gpt-6-sol-wm".to_string(),
        _ => model,
    })
}

pub fn normalize_reasoning_level(value: &str) -> Option<String> {
    let level = value.trim().to_ascii_lowercase();
    Some(match level.as_str() {
        "extra high" | "extra_high" | "extra-high" | "xhigh" => "extra-high".to_string(),
        "extended" => "high".to_string(),
        "low" | "medium" | "high" => level,
        _ => return None,
    })
}

fn is_official_conversation(host: &str, path: &str, method: &str) -> bool {
    method.eq_ignore_ascii_case("POST")
        && host.eq_ignore_ascii_case("chatgpt.com")
        && OFFICIAL_CONVERSATION_PATHS.contains(&path)
}

fn unique_models(values: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    for value in values {
        if let Some(model) = normalize_model_id(value) {
            if seen.insert(model.clone()) {
                output.push(model);
            }
        }
    }
    output
}

fn model_priority_score(value: &str) -> i64 {
    let Some(model) = normalize_model_id(value) else {
        return i64::MIN;
    };
    let version = model.strip_prefix("gpt-").unwrap_or("");
    let numeric = version.split('-').next().unwrap_or("");
    let mut parts = numeric.split('.');
    let major = parts
        .next()
        .and_then(|part| part.parse::<i64>().ok())
        .unwrap_or(0);
    let minor = parts
        .next()
        .and_then(|part| part.parse::<i64>().ok())
        .unwrap_or(0);
    let tier = if model.contains("astra") {
        500
    } else if model.contains("pro") {
        450
    } else if model.contains("sol") {
        300
    } else if model.contains("terra") {
        200
    } else if model.contains("luna") {
        100
    } else {
        0
    };
    (major * 1_000_000) + (minor * 10_000) + tier
}

fn prioritize_models(values: &[String]) -> Vec<String> {
    let mut models = unique_models(values);
    models.sort_by_key(|model| std::cmp::Reverse(model_priority_score(model)));
    models
}

fn unique_reasoning(values: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    for value in values {
        if let Some(level) = normalize_reasoning_level(value) {
            if seen.insert(level.clone()) {
                output.push(level);
            }
        }
    }
    output
}

fn reasoning_transport_value(level: &str, raw_key: &str) -> String {
    if level == "extra-high" {
        if canonical_key(raw_key).contains("thinking") {
            return "xhigh".to_string();
        }
        return "extra_high".to_string();
    }
    level.to_string()
}

pub fn evaluate_request(input: &RequestEnvelope) -> RequestDecision {
    let mut decision = RequestDecision {
        official_conversation: is_official_conversation(&input.host, &input.path, &input.method),
        changed: false,
        reason: String::new(),
        post_data: input.post_data.clone(),
        model_before: None,
        model_after: None,
        transport_model_before: None,
        transport_model_after: None,
        reasoning_before: None,
        reasoning_after: None,
        reasoning_fields: Vec::new(),
    };

    if !decision.official_conversation {
        decision.reason = "not_official_conversation".to_string();
        return decision;
    }

    let Ok(mut value) = serde_json::from_str::<Value>(&input.post_data) else {
        decision.reason = "request_body_not_json_object".to_string();
        return decision;
    };
    let Some(object) = value.as_object_mut() else {
        decision.reason = "request_body_not_json_object".to_string();
        return decision;
    };

    let locked_models = prioritize_models(&input.locked_models);
    if locked_models.is_empty() {
        decision.reason = "no_locked_model".to_string();
        return decision;
    }

    let Some(raw_model) = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        decision.reason = "top_level_model_missing".to_string();
        return decision;
    };

    decision.transport_model_before = Some(raw_model.clone());
    decision.model_before = normalize_model_id(&raw_model);
    // A multi-model policy is ordered by capability. Always request the strongest
    // selected model first; the remaining models are fallbacks, not equal peers.
    let target_model = locked_models[0].clone();
    let target_transport = if decision.model_before.as_deref() == Some(target_model.as_str()) {
        raw_model.clone()
    } else {
        match model_transport_id(&target_model) {
            Some(value) => value,
            None => {
                decision.reason = "locked_model_invalid".to_string();
                return decision;
            }
        }
    };

    if raw_model != target_transport {
        object.insert("model".to_string(), Value::String(target_transport.clone()));
        decision.changed = true;
    }
    decision.transport_model_after = Some(target_transport.clone());
    decision.model_after = normalize_model_id(&target_transport);

    let allowed_reasoning = unique_reasoning(&input.allowed_reasoning_levels);
    let preferred = input
        .preferred_reasoning
        .as_deref()
        .and_then(normalize_reasoning_level);
    let target_reasoning = preferred
        .filter(|value| allowed_reasoning.contains(value))
        .or_else(|| allowed_reasoning.first().cloned());

    let keys: Vec<String> = object.keys().cloned().collect();
    let mut reasoning_before = Vec::new();
    for key in keys {
        let canonical = canonical_key(&key);
        if !REASONING_KEYS.contains(&canonical.as_str()) {
            continue;
        }
        let Some(raw_value) = object.get(&key).and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        decision.reasoning_fields.push(key.clone());
        let current = normalize_reasoning_level(&raw_value);
        reasoning_before.push(current.clone());
        if let (Some(target), Some(current)) = (target_reasoning.as_deref(), current.as_deref()) {
            if target != current {
                object.insert(
                    key.clone(),
                    Value::String(reasoning_transport_value(target, &key)),
                );
                decision.changed = true;
            }
        }
    }

    decision.reasoning_before = reasoning_before.into_iter().flatten().next();
    decision.reasoning_after = decision
        .reasoning_fields
        .first()
        .and_then(|key| object.get(key))
        .and_then(Value::as_str)
        .and_then(normalize_reasoning_level);

    if decision.changed {
        decision.post_data =
            serde_json::to_string(&value).unwrap_or_else(|_| input.post_data.clone());
    }
    decision.reason = if decision.changed {
        "rewritten"
    } else {
        "already_locked"
    }
    .to_string();
    decision
}

fn model_from(value: &Value) -> Option<String> {
    value.as_str().and_then(normalize_model_id)
}

fn reasoning_from(value: &Value) -> Option<String> {
    value.as_str().and_then(normalize_reasoning_level)
}

fn path_score(path: &[String], key: &str, kind: &str) -> i32 {
    let metadata = path.iter().map(|part| canonical_key(part)).any(|part| {
        part.contains("metadata") || part.contains("details") || part.contains("response")
    });
    if kind == "model" {
        // Terminal response authority must match the public verifier: only fields
        // whose semantics explicitly identify the model served/resolved/used by
        // the backend may vote. Generic model_slug/model_id/backend_model fields
        // are routing/page metadata and caused false GPT-5.6 Sol mismatches in
        // v0.5.131 downstream WebSocket evidence.
        return if matches!(
            key,
            "used_model"
                | "used_model_slug"
                | "resolved_model"
                | "resolved_model_slug"
                | "served_model"
                | "served_model_slug"
        ) {
            140
        } else {
            0
        };
    }
    if metadata {
        115
    } else if path.len() <= 3 {
        95
    } else {
        0
    }
}
fn walk_value(value: &Value, candidates: &mut CandidateSet, path: &mut Vec<String>, depth: usize) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    match value {
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                path.push(index.to_string());
                walk_value(child, candidates, path, depth + 1);
                path.pop();
            }
        }
        Value::Object(object) => {
            for (raw_key, child) in object {
                let key = canonical_key(raw_key);
                path.push(raw_key.clone());
                let parent_path = &path[..path.len().saturating_sub(1)];
                if MODEL_KEYS.contains(&key.as_str()) {
                    if let Some(model) = model_from(child) {
                        let score = path_score(parent_path, &key, "model");
                        if score > 0 {
                            candidates.model.push(Candidate {
                                value: model,
                                score,
                                path: path.join("."),
                            });
                        }
                    }
                }
                if REASONING_KEYS.contains(&key.as_str()) {
                    if let Some(reasoning) = reasoning_from(child) {
                        let score = path_score(parent_path, &key, "reasoning");
                        if score > 0 {
                            candidates.reasoning.push(Candidate {
                                value: reasoning,
                                score,
                                path: path.join("."),
                            });
                        }
                    }
                }
                if !SKIPPED_CONTENT_KEYS.contains(&key.as_str()) {
                    walk_value(child, candidates, path, depth + 1);
                }
                path.pop();
            }
        }
        _ => {}
    }
}

fn select_candidate(candidates: &[Candidate]) -> Selection {
    if candidates.is_empty() {
        return Selection::default();
    }
    let best_score = candidates
        .iter()
        .map(|candidate| candidate.score)
        .max()
        .unwrap_or_default();
    let best: Vec<&Candidate> = candidates
        .iter()
        .filter(|candidate| candidate.score == best_score)
        .collect();
    let values: BTreeSet<&str> = best
        .iter()
        .map(|candidate| candidate.value.as_str())
        .collect();
    if values.len() != 1 {
        return Selection {
            value: None,
            conflict: true,
            path: None,
        };
    }
    Selection {
        value: values.iter().next().map(|value| (*value).to_string()),
        conflict: false,
        path: best.last().map(|candidate| candidate.path.clone()),
    }
}
fn inspect_objects(values: &[Value]) -> (Selection, Selection, usize, usize) {
    let mut candidates = CandidateSet::default();
    for value in values {
        walk_value(value, &mut candidates, &mut Vec::new(), 0);
    }
    let model_count = candidates.model.len();
    let reasoning_count = candidates.reasoning.len();
    (
        select_candidate(&candidates.model),
        select_candidate(&candidates.reasoning),
        model_count,
        reasoning_count,
    )
}

fn parse_json(value: &str) -> Option<Value> {
    serde_json::from_str(value).ok()
}

fn parse_sse_objects(body: &str) -> Vec<Value> {
    let mut objects = Vec::new();
    let mut data_lines = Vec::new();
    let flush = |data_lines: &mut Vec<String>, objects: &mut Vec<Value>| {
        if data_lines.is_empty() {
            return;
        }
        let data = data_lines.join("\n");
        data_lines.clear();
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            return;
        }
        if let Some(parsed) = parse_json(trimmed) {
            objects.push(parsed);
        }
    };

    for line in body.lines() {
        if line.is_empty() {
            flush(&mut data_lines, &mut objects);
        } else if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start().to_string());
        }
    }
    flush(&mut data_lines, &mut objects);
    objects
}

fn collect_embedded_stream_objects(value: &Value, objects: &mut Vec<Value>, depth: usize) {
    if depth > 10 {
        return;
    }
    match value {
        Value::Array(items) => {
            for child in items {
                collect_embedded_stream_objects(child, objects, depth + 1);
            }
        }
        Value::Object(map) => {
            for (raw_key, child) in map {
                let key = canonical_key(raw_key);
                if key == "encoded_item" {
                    if let Some(text) = child.as_str() {
                        if text.len() <= MAX_BODY_CHARS {
                            if let Some(parsed) = parse_json(text.trim()) {
                                objects.push(parsed.clone());
                                collect_embedded_stream_objects(&parsed, objects, depth + 1);
                            }
                            for parsed in parse_sse_objects(text) {
                                objects.push(parsed.clone());
                                collect_embedded_stream_objects(&parsed, objects, depth + 1);
                            }
                        }
                    }
                    continue;
                }
                if !SKIPPED_CONTENT_KEYS.contains(&key.as_str()) {
                    collect_embedded_stream_objects(child, objects, depth + 1);
                }
            }
        }
        _ => {}
    }
}

fn inspect_body(body: &str, mime_type: &str) -> BodyInspection {
    let body_length = body.len();
    if body.is_empty() {
        return BodyInspection {
            values: Vec::new(),
            body_length,
            body_format: "empty".to_string(),
        };
    }
    if body.len() > MAX_BODY_CHARS {
        return BodyInspection {
            values: Vec::new(),
            body_length,
            body_format: "too_large".to_string(),
        };
    }

    let trimmed = body.trim();
    let mut values = Vec::new();
    let mut formats = Vec::new();
    if let Some(parsed) = parse_json(trimmed) {
        values.push(parsed);
        formats.push("json");
    }
    if mime_type.to_ascii_lowercase().contains("event-stream")
        || trimmed.contains("\ndata:")
        || trimmed.starts_with("data:")
    {
        let objects = parse_sse_objects(trimmed);
        if !objects.is_empty() {
            values.extend(objects);
            formats.push("sse");
        }
    }
    if values.is_empty() && trimmed.contains('\n') {
        let mut ndjson = Vec::new();
        for line in trimmed.lines() {
            if let Some(parsed) = parse_json(line.trim()) {
                ndjson.push(parsed);
            }
        }
        if !ndjson.is_empty() {
            values.extend(ndjson);
            formats.push("ndjson");
        }
    }

    let mut embedded = Vec::new();
    for value in &values {
        collect_embedded_stream_objects(value, &mut embedded, 0);
    }
    if !embedded.is_empty() {
        values.extend(embedded);
        formats.push("embedded-sse");
    }

    BodyInspection {
        values,
        body_length,
        body_format: if formats.is_empty() {
            "unparsed".to_string()
        } else {
            formats.join("+")
        },
    }
}

fn header_value(
    headers: &BTreeMap<String, String>,
    names: &[&str],
) -> (Option<String>, Option<String>) {
    let normalized: BTreeMap<String, String> = headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.clone()))
        .collect();
    for name in names {
        if let Some(value) = normalized.get(*name) {
            return (Some(value.clone()), Some((*name).to_string()));
        }
    }
    (None, None)
}

pub fn evaluate_response(input: &ResponseEnvelope) -> EvidenceResult {
    let (raw_header_model, model_header) = header_value(&input.headers, &MODEL_HEADERS);
    let (raw_header_reasoning, reasoning_header) = header_value(&input.headers, &REASONING_HEADERS);
    let header_model = raw_header_model.as_deref().and_then(normalize_model_id);
    let header_reasoning = raw_header_reasoning
        .as_deref()
        .and_then(normalize_reasoning_level);

    let inspected = inspect_body(&input.body, &input.mime_type);
    let (body_model, body_reasoning, model_count, reasoning_count) =
        inspect_objects(&inspected.values);

    let model_conflict = body_model.conflict
        || match (&header_model, &body_model.value) {
            (Some(left), Some(right)) => left != right,
            _ => false,
        };
    let reasoning_conflict = body_reasoning.conflict
        || match (&header_reasoning, &body_reasoning.value) {
            (Some(left), Some(right)) => left != right,
            _ => false,
        };

    let model = if model_conflict {
        None
    } else {
        header_model.or(body_model.value)
    };
    let reasoning = if reasoning_conflict {
        None
    } else {
        header_reasoning.or(body_reasoning.value)
    };
    let model_field = model_header.clone().or(body_model.path);
    let reasoning_field = reasoning_header.clone().or(body_reasoning.path);

    EvidenceResult {
        model,
        reasoning,
        conflicts: EvidenceConflicts {
            model: model_conflict,
            reasoning: reasoning_conflict,
        },
        fields: EvidenceFields {
            model: model_field,
            reasoning: reasoning_field,
        },
        evidence_source: "network_response_metadata".to_string(),
        diagnostics: EvidenceDiagnostics {
            body_length: inspected.body_length,
            body_format: inspected.body_format,
            parsed_object_count: inspected.values.len(),
            model_candidate_count: model_count,
            reasoning_candidate_count: reasoning_count,
            matched_header_fields: [model_header, reasoning_header]
                .into_iter()
                .flatten()
                .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_astra_transport_alias_when_it_is_already_locked() {
        let request = RequestEnvelope {
            host: "chatgpt.com".into(),
            path: "/backend-api/f/conversation".into(),
            method: "POST".into(),
            post_data: json!({"model":"gpt-6-astra-wm","thinking_effort":"high"}).to_string(),
            locked_models: vec!["gpt-6-astra".into(), "gpt-5.6-sol".into()],
            allowed_reasoning_levels: vec!["high".into()],
            preferred_reasoning: Some("high".into()),
        };
        let decision = evaluate_request(&request);
        assert!(decision.official_conversation);
        assert!(!decision.changed);
        assert_eq!(decision.model_before.as_deref(), Some("gpt-6-astra"));
        assert_eq!(decision.model_after.as_deref(), Some("gpt-6-astra"));
        assert_eq!(
            decision.transport_model_before.as_deref(),
            Some("gpt-6-astra-wm")
        );
        assert_eq!(
            decision.transport_model_after.as_deref(),
            Some("gpt-6-astra-wm")
        );
    }

    #[test]
    fn rewrites_allowed_sol_request_to_stronger_selected_astra() {
        let request = RequestEnvelope {
            host: "chatgpt.com".into(),
            path: "/backend-api/f/conversation".into(),
            method: "POST".into(),
            post_data: json!({"model":"gpt-5.6-sol-wm","thinking_effort":"high"}).to_string(),
            locked_models: vec!["gpt-5.6-sol".into(), "gpt-6-astra".into()],
            allowed_reasoning_levels: vec!["high".into()],
            preferred_reasoning: Some("high".into()),
        };
        let decision = evaluate_request(&request);
        assert!(decision.official_conversation);
        assert!(decision.changed);
        assert_eq!(decision.model_before.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(decision.model_after.as_deref(), Some("gpt-6-astra"));
        assert_eq!(
            decision.transport_model_after.as_deref(),
            Some("gpt-6-astra-wm")
        );
    }

    #[test]
    fn rewrites_only_official_chat_request_and_existing_reasoning_fields() {
        let request = RequestEnvelope {
            host: "chatgpt.com".into(),
            path: "/backend-api/conversation".into(),
            method: "POST".into(),
            post_data: json!({"model":"gpt-5.5","reasoning_effort":"medium","messages":[]})
                .to_string(),
            locked_models: vec!["gpt-5.6-sol".into()],
            allowed_reasoning_levels: vec!["high".into()],
            preferred_reasoning: Some("high".into()),
        };
        let decision = evaluate_request(&request);
        assert!(decision.official_conversation);
        assert!(decision.changed);
        let body: Value = serde_json::from_str(&decision.post_data).unwrap();
        assert_eq!(body["model"], "gpt-5.6-sol-wm");
        assert_eq!(body["reasoning_effort"], "high");
        assert!(body.get("thinking_level").is_none());
    }

    #[test]
    fn does_not_treat_message_content_as_model_evidence() {
        let response = ResponseEnvelope {
            body: json!({
                "message": {"content": {"parts": ["model: gpt-5.6-sol"]}},
                "metadata": {"served_model_slug":"gpt-5.5", "reasoning_effort":"high"}
            })
            .to_string(),
            headers: BTreeMap::new(),
            mime_type: "application/json".into(),
        };
        let evidence = evaluate_response(&response);
        assert_eq!(evidence.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(evidence.reasoning.as_deref(), Some("high"));
    }

    #[test]
    fn generic_model_slug_and_default_metadata_are_not_served_model_proof() {
        let response = ResponseEnvelope {
            body: json!({
                "metadata": {
                    "model_slug":"gpt-6-astra-wm",
                    "default_model_slug":"gpt-5.6-sol-wm",
                    "model_name":"gpt-6-astra-wm"
                }
            })
            .to_string(),
            headers: BTreeMap::new(),
            mime_type: "application/json".into(),
        };
        let evidence = evaluate_response(&response);
        assert!(!evidence.conflicts.model);
        assert_eq!(evidence.model, None);
        assert_eq!(evidence.diagnostics.model_candidate_count, 0);
    }

    #[test]
    fn conflicting_high_confidence_metadata_is_not_accepted() {
        let response = ResponseEnvelope {
            body: json!({
                "metadata": {
                    "served_model_slug":"gpt-5.5",
                    "resolved_model_slug":"gpt-5.6-sol-wm",
                    "reasoning_effort":"high"
                }
            })
            .to_string(),
            headers: BTreeMap::new(),
            mime_type: "application/json".into(),
        };
        let evidence = evaluate_response(&response);
        assert!(evidence.conflicts.model);
        assert!(evidence.model.is_none());
    }
}

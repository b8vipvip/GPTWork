mod context_budget;
mod context_profile;

use std::collections::BTreeSet;
use std::io::{self, ErrorKind, Read, Write};

use context_budget::{evaluate_context_budget, ContextBudgetInput};
use context_profile::{evaluate_context_profile, ContextProfileEvaluationInput};
use gptwork_private_engine::{
    evaluate_request, evaluate_response, RequestDecision, RequestEnvelope, ResponseEnvelope,
};
use serde_json::{json, Value};

const PROTOCOL_VERSION: u64 = 2;
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "invalid frame length",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_frame<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error.to_string()))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "response frame too large",
        ));
    }
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

fn error(id: Value, code: &str, message: impl Into<String>) -> Value {
    json!({ "id": id, "ok": false, "protocolVersion": PROTOCOL_VERSION, "error": { "code": code, "message": message.into() } })
}

fn request_patches(before: &str, after: &str) -> Vec<Value> {
    let Ok(Value::Object(before)) = serde_json::from_str::<Value>(before) else {
        return Vec::new();
    };
    let Ok(Value::Object(after)) = serde_json::from_str::<Value>(after) else {
        return Vec::new();
    };
    let mut keys = BTreeSet::new();
    keys.extend(before.keys().cloned());
    keys.extend(after.keys().cloned());
    let mut patches = Vec::new();
    for key in keys {
        match (before.get(&key), after.get(&key)) {
            (Some(left), Some(right)) if left == right => {}
            (None, Some(value)) => patches.push(json!({"op":"add","path":[key],"value":value})),
            (Some(_), None) => patches.push(json!({"op":"remove","path":[key]})),
            (Some(_), Some(value)) => {
                patches.push(json!({"op":"replace","path":[key],"value":value}))
            }
            (None, None) => {}
        }
    }
    patches
}

fn compact_request_decision(input: &RequestEnvelope, decision: RequestDecision) -> Value {
    let patches = if decision.changed {
        request_patches(&input.post_data, &decision.post_data)
    } else {
        Vec::new()
    };
    let mut value = serde_json::to_value(decision).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.remove("postData");
        object.insert("patches".to_string(), Value::Array(patches));
    }
    value
}

fn evaluate_context_payload(payload: Value) -> Result<Value, String> {
    if payload.get("mode").and_then(Value::as_str) == Some("profile") {
        let profile = payload
            .get("profileEvaluation")
            .cloned()
            .unwrap_or(Value::Null);
        return serde_json::from_value::<ContextProfileEvaluationInput>(profile)
            .map_err(|e| e.to_string())
            .and_then(|i| evaluate_context_profile(&i))
            .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()));
    }
    if payload.get("mode").and_then(Value::as_str) == Some("budget") {
        let budget = payload.get("budget").cloned().unwrap_or(Value::Null);
        return serde_json::from_value::<ContextBudgetInput>(budget)
            .map_err(|e| e.to_string())
            .and_then(|i| evaluate_context_budget(&i))
            .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()));
    }
    Err("unsupported context evaluation mode".to_string())
}

fn is_protected(kind: &str) -> bool {
    matches!(
        kind,
        "evaluate_request" | "evaluate_response" | "evaluate_context"
    )
}
fn has_capability_lease(message: &Value) -> bool {
    message
        .get("capabilityLease")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn handle(message: Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    if message.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return error(
            id,
            "unsupported_protocol",
            "unsupported core bridge protocol version",
        );
    }
    let Some(kind) = message.get("type").and_then(Value::as_str) else {
        return error(id, "invalid_message", "missing message type");
    };
    if is_protected(kind) && !has_capability_lease(&message) {
        return error(
            id,
            "capability_lease_required",
            "server-issued capability lease required",
        );
    }
    let payload = message.get("payload").cloned().unwrap_or_else(|| json!({}));
    let result = match kind {
        "get_capabilities" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION, "requestEvaluation": true, "responseEvaluation": true,
            "contextBudgetEvaluation": true, "contextProfileEvaluation": true, "compactRequestPatches": true,
            "capabilityLeaseRequired": true, "capabilityLeaseVerified": false
        })),
        // Phase A intentionally accepts no assertion from extension/local state as authority.
        // Phase B will verify the server signature before reaching these evaluators.
        "evaluate_request" => serde_json::from_value::<RequestEnvelope>(payload)
            .map(|input| {
                let decision = evaluate_request(&input);
                compact_request_decision(&input, decision)
            })
            .map_err(|e| e.to_string()),
        "evaluate_response" => serde_json::from_value::<ResponseEnvelope>(payload)
            .map(|input| json!(evaluate_response(&input)))
            .map_err(|e| e.to_string()),
        "evaluate_context" => evaluate_context_payload(payload),
        _ => return error(id, "unsupported_message", "unsupported core bridge message"),
    };
    match result {
        Ok(data) => json!({"id":id,"ok":true,"protocolVersion":PROTOCOL_VERSION,"data":data}),
        Err(message) => error(id, "invalid_payload", message),
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    while let Some(frame) = read_frame(&mut reader)? {
        let message = match serde_json::from_slice::<Value>(&frame) {
            Ok(value) => value,
            Err(e) => {
                write_frame(
                    &mut writer,
                    &error(Value::Null, "invalid_json", e.to_string()),
                )?;
                continue;
            }
        };
        write_frame(&mut writer, &handle(message))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_are_protocol_v2_and_report_lease_boundary() {
        let response =
            handle(json!({"id":"1","type":"get_capabilities","protocolVersion":2,"payload":{}}));
        assert_eq!(response["ok"], true);
        assert_eq!(response["protocolVersion"], 2);
        assert_eq!(response["data"]["compactRequestPatches"], true);
        assert_eq!(response["data"]["capabilityLeaseRequired"], true);
        assert_eq!(response["data"]["capabilityLeaseVerified"], false);
    }

    #[test]
    fn every_protected_operation_rejects_missing_lease_before_payload_evaluation() {
        for operation in ["evaluate_request", "evaluate_response", "evaluate_context"] {
            let response =
                handle(json!({"id":operation,"type":operation,"protocolVersion":2,"payload":{}}));
            assert_eq!(response["ok"], false);
            assert_eq!(response["error"]["code"], "capability_lease_required");
        }
    }

    #[test]
    fn context_evaluation_requires_an_explicit_private_mode_after_lease_gate() {
        let response = handle(
            json!({"id":"ctx-1","type":"evaluate_context","protocolVersion":2,"capabilityLease":"phase-a-test-token","payload":{"snapshot":{},"profile":{}}}),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "invalid_payload");
    }

    #[test]
    fn top_level_patch_diff_is_generic() {
        let patches = request_patches("{\"a\":1,\"b\":2}", "{\"a\":3,\"c\":4}");
        assert_eq!(patches.len(), 3);
        assert!(patches
            .iter()
            .any(|p| p["op"] == "replace" && p["path"] == json!(["a"])));
        assert!(patches
            .iter()
            .any(|p| p["op"] == "remove" && p["path"] == json!(["b"])));
        assert!(patches
            .iter()
            .any(|p| p["op"] == "add" && p["path"] == json!(["c"])));
    }
}

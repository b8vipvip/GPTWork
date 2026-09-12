use std::io::{self, ErrorKind, Read, Write};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::config::Policy;
use crate::private_engine;
use crate::updater::{prepare_update, PrepareUpdateRequest};
use crate::verifier::VerificationRequest;
use crate::{AppState, PROTOCOL_VERSION};

const MAX_NATIVE_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_NATIVE_RESPONSE_BYTES: usize = 1024 * 1024;
const PRIVATE_ENGINE_PROTOCOL_VERSION: u64 = 2;

pub fn run_native_host(state: Arc<AppState>) -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    run_native_host_with_io(stdin.lock(), stdout.lock(), state)
}

fn run_native_host_with_io<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    state: Arc<AppState>,
) -> Result<()> {
    loop {
        let Some(message) = read_message(&mut reader)? else {
            return Ok(());
        };
        let response = handle_message(&state, message);
        write_message(&mut writer, &response)?;
    }
}

fn read_message<R: Read>(reader: &mut R) -> Result<Option<Value>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error).context("read native message length"),
    }
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_NATIVE_REQUEST_BYTES {
        anyhow::bail!("invalid native message length: {length}");
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .context("read native message payload")?;
    serde_json::from_slice(&payload)
        .context("parse native message JSON")
        .map(Some)
}

fn write_message<W: Write>(writer: &mut W, message: &Value) -> Result<()> {
    let payload = serde_json::to_vec(message).context("serialize native response")?;
    if payload.len() > MAX_NATIVE_RESPONSE_BYTES {
        anyhow::bail!("native response is too large");
    }
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .context("write native response length")?;
    writer
        .write_all(&payload)
        .context("write native response payload")?;
    writer.flush().context("flush native response")?;
    Ok(())
}

fn is_private_engine_message(message_type: &str) -> bool {
    matches!(
        message_type,
        "evaluate_request" | "evaluate_response" | "evaluate_context"
    )
}

fn handle_message(state: &Arc<AppState>, message: Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(message_type) = message
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return error_response(
            id,
            "invalid_message",
            "消息缺少 type 字段",
            "Message is missing the type field",
        );
    };

    if is_private_engine_message(&message_type) {
        return match private_engine::request(message) {
            Ok(response) => response,
            Err(error) => private_engine_error(id, error.to_string()),
        };
    }

    let result = match message_type.as_str() {
        "ping" => Ok(json!({
            "type": "pong",
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": PROTOCOL_VERSION,
        })),
        "get_capabilities" => Ok(json!({
            "nativeMessaging": true,
            "localhostApi": true,
            "policyPersistence": true,
            "auditLog": true,
            "diagnosticExport": true,
            "oneClickWindowsUpdate": cfg!(windows),
            "privateEngine": private_engine::capability(),
            "sufficientEvidenceSources": [
                "network_response_metadata",
                "conversation_response_metadata"
            ],
            "informationalEvidenceSources": [
                "network_request_metadata",
                "page_dom",
                "user_selection",
                "unknown"
            ]
        })),
        "get_policy" => state
            .policy()
            .map(|(policy, revision)| json!({ "policy": policy, "revision": revision })),
        "set_policy" => message
            .get("policy")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("policy is required / 缺少 policy"))
            .and_then(|value| serde_json::from_value::<Policy>(value).map_err(Into::into))
            .and_then(|policy| state.set_policy(policy, "native_messaging"))
            .map(|(policy, revision)| json!({ "policy": policy, "revision": revision })),
        "verify" => (|| -> Result<Value> {
            let request_value = message
                .get("observation")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("observation is required / 缺少 observation"))?;
            let request = serde_json::from_value::<VerificationRequest>(request_value)?;
            let policy_override = message
                .get("policy")
                .cloned()
                .map(serde_json::from_value::<Policy>)
                .transpose()?;
            let result = state.verify_with_policy(request, policy_override)?;
            Ok(serde_json::to_value(result)?)
        })(),
        "prepare_update" => message
            .get("update")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("update is required / 缺少 update"))
            .and_then(|value| {
                serde_json::from_value::<PrepareUpdateRequest>(value).map_err(Into::into)
            })
            .and_then(prepare_update)
            .and_then(|result| serde_json::to_value(result).map_err(Into::into)),
        "get_status" => state
            .status()
            .and_then(|status| serde_json::to_value(status).map_err(Into::into)),
        "get_diagnostics" => {
            let audit_limit = message
                .get("auditLimit")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .clamp(1, 500) as usize;
            state.doctor_report().and_then(|doctor| {
                state
                    .recent_audit_records(audit_limit)
                    .map(|audit_records| {
                        json!({
                            "doctor": doctor,
                            "auditRecords": audit_records,
                        })
                    })
            })
        }
        _ => {
            return error_response(
                id,
                "unsupported_message",
                format!("不支持的消息类型：{message_type}"),
                format!("Unsupported message type: {message_type}"),
            )
        }
    };

    match result {
        Ok(data) => json!({
            "id": id,
            "ok": true,
            "protocolVersion": PROTOCOL_VERSION,
            "data": data,
        }),
        Err(error) => error_response(
            id,
            "request_failed",
            format!("本地核心处理失败：{error}"),
            format!("Local core request failed: {error}"),
        ),
    }
}

fn private_engine_error(id: Value, detail: String) -> Value {
    json!({
        "id": id,
        "ok": false,
        "protocolVersion": PRIVATE_ENGINE_PROTOCOL_VERSION,
        "error": {
            "code": "private_engine_unavailable",
            "message": detail,
            "messageZhCn": "私有核心组件当前不可用",
            "messageEn": "Private core component is unavailable",
        }
    })
}

fn error_response(
    id: Value,
    code: &str,
    message_zh_cn: impl Into<String>,
    message_en: impl Into<String>,
) -> Value {
    json!({
        "id": id,
        "ok": false,
        "protocolVersion": PROTOCOL_VERSION,
        "error": {
            "code": code,
            "messageZhCn": message_zh_cn.into(),
            "messageEn": message_en.into(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigStore;

    #[test]
    fn native_frame_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        let request = json!({ "id": "1", "type": "ping" });
        let mut framed = Vec::new();
        write_message(&mut framed, &request).unwrap();
        let parsed = read_message(&mut framed.as_slice()).unwrap().unwrap();
        let response = handle_message(&state, parsed);
        assert_eq!(response["ok"], true);
        assert_eq!(response["data"]["type"], "pong");
    }

    #[test]
    fn capabilities_report_private_engine_protocol_without_requiring_artifact() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        let response = handle_message(&state, json!({ "id": "cap", "type": "get_capabilities" }));
        assert_eq!(response["ok"], true);
        assert_eq!(response["data"]["privateEngine"]["protocolVersion"], 2);
        assert!(response["data"]["privateEngine"]["available"].is_boolean());
    }

    #[test]
    fn private_engine_messages_keep_protocol_v2_error_shape_when_artifact_is_absent() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        if private_engine::available() {
            return;
        }
        let response = handle_message(
            &state,
            json!({
                "id": "private-1",
                "type": "evaluate_request",
                "protocolVersion": 2,
                "payload": {}
            }),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["protocolVersion"], 2);
        assert_eq!(response["error"]["code"], "private_engine_unavailable");
    }

    #[test]
    fn rejects_unknown_native_message() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        let response = handle_message(&state, json!({ "id": 7, "type": "delete_everything" }));
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "unsupported_message");
    }

    #[test]
    fn rejects_invalid_update_requests() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        let response = handle_message(
            &state,
            json!({
                "id": 9,
                "type": "prepare_update",
                "update": {
                    "installerPath": "evil.exe",
                    "expectedSha256": "abc",
                    "targetVersion": "0.4.0"
                }
            }),
        );
        assert_eq!(response["ok"], false);
    }

    #[test]
    fn verification_accepts_policy_override_without_persisting_it() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        let before = state.policy().unwrap().0;
        let response = handle_message(
            &state,
            json!({
                "id": "tab-policy",
                "type": "verify",
                "policy": {
                    "lockedModels": ["gpt-6-astra"],
                    "allowedReasoningLevels": ["high"],
                    "strictMode": true
                },
                "observation": {
                    "model": "gpt-6-astra",
                    "reasoning": "high",
                    "evidenceSource": "network_response_metadata",
                    "requestId": "cdp-123-1"
                }
            }),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["data"]["verdict"], "verified");
        assert_eq!(state.policy().unwrap().0, before);
    }

    #[test]
    fn exports_bounded_diagnostics_without_chat_content() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
        let verification = handle_message(
            &state,
            json!({
                "id": 1,
                "type": "verify",
                "observation": {
                    "model": "gpt-5.6-sol",
                    "reasoning": "high",
                    "evidenceSource": "network_response_metadata",
                    "capturedAt": "2026-08-25T00:00:00Z",
                    "requestId": "diagnostic-test"
                }
            }),
        );
        assert_eq!(verification["ok"], true);

        let response = handle_message(
            &state,
            json!({ "id": 2, "type": "get_diagnostics", "auditLimit": 10 }),
        );
        assert_eq!(response["ok"], true);
        assert!(response["data"]["doctor"]["auditFile"].is_string());
        assert_eq!(
            response["data"]["auditRecords"].as_array().unwrap().len(),
            1
        );
        assert!(response["data"].get("chatContent").is_none());
    }
}

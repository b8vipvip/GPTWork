mod capability_lease;

use std::io;

use capability_lease::{verify_capability_lease, LeaseBinding};

use serde_json::Value;

#[allow(dead_code)]
mod base {
    pub fn read_frame_public<R: std::io::Read>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
        read_frame(reader)
    }

    pub fn write_frame_public<W: std::io::Write>(
        writer: &mut W,
        value: &Value,
    ) -> std::io::Result<()> {
        write_frame(writer, value)
    }

    pub fn handle_public(value: Value) -> Value {
        handle(value)
    }

    pub fn error_public(id: Value, code: &str, message: impl Into<String>) -> Value {
        error(id, code, message)
    }

    include!("main_base.rs");
}

fn protected_operation(value: &str) -> bool {
    matches!(
        value,
        "evaluate_request" | "evaluate_response" | "evaluate_context"
    )
}

fn verified_handle(message: Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let operation = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if protected_operation(operation) {
        let lease = match message.get("capabilityLease").and_then(Value::as_str) {
            Some(value) if !value.trim().is_empty() => value,
            _ => {
                return base::error_public(
                    id,
                    "capability_lease_required",
                    "Protected private-engine operation requires a server capability lease",
                )
            }
        };
        let binding = match message.get("leaseBinding").cloned() {
            Some(value) => match serde_json::from_value::<LeaseBinding>(value) {
                Ok(binding) => binding,
                Err(_) => {
                    return base::error_public(
                        id,
                        "capability_lease_binding_required",
                        "Protected private-engine operation requires a complete lease binding",
                    )
                }
            },
            None => {
                return base::error_public(
                    id,
                    "capability_lease_binding_required",
                    "Protected private-engine operation requires a complete lease binding",
                )
            }
        };
        if let Err(error) = verify_capability_lease(lease, &binding, operation) {
            return base::error_public(id, error.code, error.message);
        }
    }
    base::handle_public(message)
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    while let Some(frame) = base::read_frame_public(&mut reader)? {
        let message = match serde_json::from_slice::<Value>(&frame) {
            Ok(value) => value,
            Err(error) => {
                base::write_frame_public(
                    &mut writer,
                    &base::error_public(Value::Null, "invalid_json", error.to_string()),
                )?;
                continue;
            }
        };
        base::write_frame_public(&mut writer, &verified_handle(message))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn protected_dispatch_requires_binding_before_private_evaluator() {
        let response = verified_handle(json!({
            "id": "lease-binding",
            "type": "evaluate_request",
            "protocolVersion": 2,
            "capabilityLease": "opaque-but-unverified",
            "payload": {}
        }));
        assert_eq!(response["ok"], false);
        assert_eq!(
            response["error"]["code"],
            "capability_lease_binding_required"
        );
    }

    #[test]
    fn capabilities_remain_available_without_authorizing_protected_work() {
        let response = verified_handle(json!({
            "id": "capabilities",
            "type": "get_capabilities",
            "protocolVersion": 2,
            "payload": {}
        }));
        assert_eq!(response["ok"], true);
        assert_eq!(response["data"]["capabilityLeaseRequired"], true);
    }
}

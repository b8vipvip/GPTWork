use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

const LEASE_VERSION: u8 = 1;
const LEASE_ISSUER: &str = "https://gptlock.mv3.cn";
const LEASE_AUDIENCE: &str = "gptwork-private-engine";
const LEASE_HEADER_ALG: &str = "EdDSA";
const LEASE_HEADER_TYPE: &str = "GPTWORK-LEASE";
const LEASE_KEY_ID: &str = "gptwork-lease-v1";
const CLOCK_SKEW_SECONDS: i64 = 5;
const MAX_LEASE_SECONDS: i64 = 900;
const MAX_TOKEN_PART_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone)]
pub struct LeaseError {
    pub code: &'static str,
    pub message: &'static str,
}

impl LeaseError {
    fn invalid(message: &'static str) -> Self {
        Self {
            code: "capability_lease_invalid",
            message,
        }
    }

    fn unconfigured() -> Self {
        Self {
            code: "capability_lease_verifier_unconfigured",
            message: "Capability lease verification key is not configured",
        }
    }
}

#[derive(Debug, Deserialize)]
struct LeaseHeader {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Debug, Deserialize)]
struct LeaseClaims {
    version: u8,
    issuer: String,
    audience: String,
    subject: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "browserInstanceId")]
    browser_instance_id: String,
    #[serde(rename = "extensionId")]
    extension_id: String,
    features: Vec<String>,
    #[serde(rename = "windowKeys")]
    window_keys: Vec<String>,
    #[serde(rename = "issuedAt")]
    issued_at: i64,
    #[serde(rename = "notBefore")]
    not_before: i64,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
    jti: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseBinding {
    pub device_id: String,
    pub browser_instance_id: String,
    pub extension_id: String,
    pub window_key: String,
}

fn unix_seconds() -> Result<i64, LeaseError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .map_err(|_| LeaseError::invalid("System clock is before the Unix epoch"))
}

fn decode_part(value: &str) -> Result<Vec<u8>, LeaseError> {
    if value.is_empty() || value.len() > MAX_TOKEN_PART_BYTES {
        return Err(LeaseError::invalid("Capability lease token part is invalid"));
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| LeaseError::invalid("Capability lease token is not valid base64url"))
}

fn production_verifying_key() -> Result<VerifyingKey, LeaseError> {
    let encoded = option_env!("GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64")
        .unwrap_or("")
        .trim();
    if encoded.is_empty() {
        return Err(LeaseError::unconfigured());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| LeaseError::unconfigured())?;
    let raw: [u8; 32] = bytes.try_into().map_err(|_| LeaseError::unconfigured())?;
    VerifyingKey::from_bytes(&raw).map_err(|_| LeaseError::unconfigured())
}

pub fn verifier_configured() -> bool {
    production_verifying_key().is_ok()
}

pub fn verify_capability_lease(
    token: &str,
    binding: &LeaseBinding,
    operation: &str,
) -> Result<(), LeaseError> {
    let key = production_verifying_key()?;
    verify_with_key(token, binding, operation, unix_seconds()?, &key)
}

fn verify_with_key(
    token: &str,
    binding: &LeaseBinding,
    operation: &str,
    now: i64,
    key: &VerifyingKey,
) -> Result<(), LeaseError> {
    let mut parts = token.split('.');
    let header_part = parts.next().unwrap_or_default();
    let claims_part = parts.next().unwrap_or_default();
    let signature_part = parts.next().unwrap_or_default();
    if parts.next().is_some() || header_part.is_empty() || claims_part.is_empty() || signature_part.is_empty() {
        return Err(LeaseError::invalid("Capability lease token shape is invalid"));
    }

    let header: LeaseHeader = serde_json::from_slice(&decode_part(header_part)?)
        .map_err(|_| LeaseError::invalid("Capability lease header is invalid"))?;
    if header.alg != LEASE_HEADER_ALG || header.typ != LEASE_HEADER_TYPE || header.kid != LEASE_KEY_ID {
        return Err(LeaseError::invalid("Capability lease header is not supported"));
    }

    let claims_bytes = decode_part(claims_part)?;
    let signature_bytes = decode_part(signature_part)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| LeaseError::invalid("Capability lease signature is malformed"))?;
    let signing_input = format!("{header_part}.{claims_part}");
    key.verify(signing_input.as_bytes(), &signature)
        .map_err(|_| LeaseError::invalid("Capability lease signature is invalid"))?;

    let claims: LeaseClaims = serde_json::from_slice(&claims_bytes)
        .map_err(|_| LeaseError::invalid("Capability lease claims are invalid"))?;
    if claims.version != LEASE_VERSION || claims.issuer != LEASE_ISSUER || claims.audience != LEASE_AUDIENCE {
        return Err(LeaseError::invalid("Capability lease issuer or audience is invalid"));
    }
    if claims.subject.is_empty() || claims.session_id.is_empty() || claims.jti.is_empty() {
        return Err(LeaseError::invalid("Capability lease identity is incomplete"));
    }
    if claims.issued_at > now + CLOCK_SKEW_SECONDS || claims.not_before > now + CLOCK_SKEW_SECONDS {
        return Err(LeaseError::invalid("Capability lease is not valid yet"));
    }
    if claims.expires_at <= now - CLOCK_SKEW_SECONDS {
        return Err(LeaseError::invalid("Capability lease has expired"));
    }
    if claims.expires_at <= claims.issued_at
        || claims.expires_at - claims.issued_at > MAX_LEASE_SECONDS
        || claims.not_before > claims.expires_at
    {
        return Err(LeaseError::invalid("Capability lease lifetime is invalid"));
    }
    if claims.device_id != binding.device_id
        || claims.browser_instance_id != binding.browser_instance_id
        || claims.extension_id != binding.extension_id
    {
        return Err(LeaseError::invalid("Capability lease client binding does not match"));
    }
    if !claims.window_keys.iter().any(|value| value == &binding.window_key) {
        return Err(LeaseError::invalid("Capability lease window is not admitted"));
    }
    if !claims.features.iter().any(|value| value == operation) {
        return Err(LeaseError::invalid("Capability lease does not grant this operation"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{json, Value};

    const NOW: i64 = 2_000_000_000;

    fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn binding() -> LeaseBinding {
        LeaseBinding {
            device_id: "device:12345678".into(),
            browser_instance_id: "browser:12345678".into(),
            extension_id: "bhchcpeodphgjfjoookncemnamdbfcof".into(),
            window_key: "chrome:100".into(),
        }
    }

    fn claims() -> Value {
        json!({
            "version": 1,
            "issuer": LEASE_ISSUER,
            "audience": LEASE_AUDIENCE,
            "subject": "user:42",
            "sessionId": "session:9",
            "deviceId": "device:12345678",
            "browserInstanceId": "browser:12345678",
            "extensionId": "bhchcpeodphgjfjoookncemnamdbfcof",
            "features": ["evaluate_request", "evaluate_response", "evaluate_context"],
            "windowKeys": ["chrome:100"],
            "issuedAt": NOW,
            "notBefore": NOW - 5,
            "expiresAt": NOW + 300,
            "jti": "lease:test:12345678"
        })
    }

    fn token(value: Value, key: &SigningKey) -> String {
        let header = json!({ "alg": LEASE_HEADER_ALG, "typ": LEASE_HEADER_TYPE, "kid": LEASE_KEY_ID });
        let header_part = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
        let claims_part = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap());
        let signing_input = format!("{header_part}.{claims_part}");
        let signature = key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn verify(value: Value, binding: &LeaseBinding, operation: &str) -> Result<(), LeaseError> {
        let key = signing_key(7);
        verify_with_key(&token(value, &key), binding, operation, NOW, &key.verifying_key())
    }

    #[test]
    fn accepts_valid_server_lease() {
        assert!(verify(claims(), &binding(), "evaluate_request").is_ok());
    }

    #[test]
    fn rejects_bad_signature_and_time_bounds() {
        let signer = signing_key(7);
        let attacker = signing_key(8);
        let forged = token(claims(), &attacker);
        assert!(verify_with_key(&forged, &binding(), "evaluate_request", NOW, &signer.verifying_key()).is_err());

        let mut expired = claims();
        expired["expiresAt"] = json!(NOW - 30);
        assert!(verify(expired, &binding(), "evaluate_request").is_err());

        let mut future = claims();
        future["issuedAt"] = json!(NOW + 60);
        future["notBefore"] = json!(NOW + 60);
        future["expiresAt"] = json!(NOW + 360);
        assert!(verify(future, &binding(), "evaluate_request").is_err());
    }

    #[test]
    fn rejects_wrong_issuer_audience_and_feature() {
        let mut wrong_issuer = claims();
        wrong_issuer["issuer"] = json!("https://attacker.invalid");
        assert!(verify(wrong_issuer, &binding(), "evaluate_request").is_err());

        let mut wrong_audience = claims();
        wrong_audience["audience"] = json!("gptwork-browser");
        assert!(verify(wrong_audience, &binding(), "evaluate_request").is_err());

        let mut wrong_feature = claims();
        wrong_feature["features"] = json!(["evaluate_response"]);
        assert!(verify(wrong_feature, &binding(), "evaluate_request").is_err());
    }

    #[test]
    fn rejects_wrong_device_browser_extension_and_window_bindings() {
        let mut wrong = binding();
        wrong.device_id = "device:attacker".into();
        assert!(verify(claims(), &wrong, "evaluate_request").is_err());

        let mut wrong = binding();
        wrong.browser_instance_id = "browser:attacker".into();
        assert!(verify(claims(), &wrong, "evaluate_request").is_err());

        let mut wrong = binding();
        wrong.extension_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into();
        assert!(verify(claims(), &wrong, "evaluate_request").is_err());

        let mut wrong = binding();
        wrong.window_key = "chrome:101".into();
        assert!(verify(claims(), &wrong, "evaluate_request").is_err());
    }
}

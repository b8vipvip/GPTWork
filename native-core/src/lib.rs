pub mod api;
pub mod bridge;
pub mod config;
pub mod logger;
pub mod private_engine;
pub mod updater;
pub mod verifier;

use std::sync::{Arc, RwLock};
use std::time::Instant;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

use config::{ConfigStore, Policy};
use logger::AuditLogger;
use verifier::{VerificationRequest, VerificationResult};

pub const NATIVE_HOST_NAME: &str = "com.gptlock.core";
pub const PROTOCOL_VERSION: u32 = 1;

pub struct AppState {
    store: ConfigStore,
    audit: AuditLogger,
    api_token: String,
    started_at: Instant,
    last_verification: RwLock<Option<VerificationResult>>,
}

impl AppState {
    pub fn initialize(store: ConfigStore) -> Result<Arc<Self>> {
        store.initialize()?;
        let api_token = store.load_or_create_api_token()?;
        let audit = AuditLogger::new(store.logs_dir())?;
        let last_verification = store.load_last_verification().unwrap_or(None);

        Ok(Arc::new(Self {
            store,
            audit,
            api_token,
            started_at: Instant::now(),
            last_verification: RwLock::new(last_verification),
        }))
    }

    pub fn api_token(&self) -> &str {
        &self.api_token
    }

    pub fn device_id(&self) -> String {
        stable_device_id(&self.api_token)
    }

    pub fn config_store(&self) -> &ConfigStore {
        &self.store
    }

    pub fn policy(&self) -> Result<(Policy, String)> {
        let policy = self.store.load_policy()?;
        let revision = policy.revision()?;
        Ok((policy, revision))
    }

    pub fn set_policy(&self, policy: Policy, source: &str) -> Result<(Policy, String)> {
        let policy = policy.normalized()?;
        if self.store.load_policy()? == policy {
            let revision = policy.revision()?;
            return Ok((policy, revision));
        }
        let policy = self.store.save_policy(policy)?;
        let revision = policy.revision()?;
        self.audit.record_policy_update(&revision, source)?;
        Ok((policy, revision))
    }

    pub fn verify(&self, request: VerificationRequest) -> Result<VerificationResult> {
        self.verify_with_policy(request, None)
    }

    pub fn verify_with_policy(
        &self,
        request: VerificationRequest,
        policy_override: Option<Policy>,
    ) -> Result<VerificationResult> {
        let (policy, revision) = match policy_override {
            Some(policy) => {
                let policy = policy.normalized()?;
                let revision = policy.revision()?;
                (policy, revision)
            }
            None => self.policy()?,
        };
        let result = verifier::verify(&policy, &revision, request);
        self.audit.record_verification(&result)?;
        self.store.save_last_verification(&result)?;
        *self
            .last_verification
            .write()
            .map_err(|_| anyhow::anyhow!("last verification lock is poisoned"))? =
            Some(result.clone());
        Ok(result)
    }

    pub fn status(&self) -> Result<CoreStatus> {
        let (policy, revision) = self.policy()?;
        let cached_verification = self
            .last_verification
            .read()
            .map_err(|_| anyhow::anyhow!("last verification lock is poisoned"))?
            .clone();
        let last_verification = self.store.load_last_verification()?.or(cached_verification);

        Ok(CoreStatus {
            status: "ok",
            version: env!("CARGO_PKG_VERSION"),
            protocol_version: PROTOCOL_VERSION,
            device_id: self.device_id(),
            uptime_seconds: self.started_at.elapsed().as_secs(),
            policy_revision: revision,
            strict_mode: policy.strict_mode,
            last_verification,
            verification_boundary: VerificationBoundary {
                zh_cn: "仅验证扩展提供且标注来源的证据；页面显示或用户选择本身不会被声明为后端模型证明。",
                en: "Only source-labelled evidence supplied by the extension is evaluated; UI text or a user selection alone is never claimed as proof of the backend model.",
            },
        })
    }

    pub fn doctor_report(&self) -> Result<DoctorReport> {
        let status = self.status()?;
        Ok(DoctorReport {
            status,
            data_root: self
                .store
                .root()
                .to_str()
                .context("GPTWork data path is not valid UTF-8")?
                .to_owned(),
            policy_file: self
                .store
                .policy_path()
                .to_str()
                .context("GPTWork policy path is not valid UTF-8")?
                .to_owned(),
            audit_file: self
                .audit
                .path()
                .to_str()
                .context("GPTWork audit path is not valid UTF-8")?
                .to_owned(),
            native_host_name: NATIVE_HOST_NAME,
        })
    }

    pub fn recent_audit_records(&self, limit: usize) -> Result<Vec<Value>> {
        self.audit.recent_records(limit)
    }
}

fn stable_device_id(token: &str) -> String {
    fn fnv64(value: &[u8]) -> u64 {
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in value {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    let first = fnv64(format!("gptlock-device-v1:{token}").as_bytes());
    let second = fnv64(format!("{token}:gptlock-device-v1").as_bytes());
    format!("device-{first:016x}{second:016x}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub status: &'static str,
    pub version: &'static str,
    pub protocol_version: u32,
    pub device_id: String,
    pub uptime_seconds: u64,
    pub policy_revision: String,
    pub strict_mode: bool,
    pub last_verification: Option<VerificationResult>,
    pub verification_boundary: VerificationBoundary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationBoundary {
    pub zh_cn: &'static str,
    pub en: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub status: CoreStatus,
    pub data_root: String,
    pub policy_file: String,
    pub audit_file: String,
    pub native_host_name: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_stable_and_does_not_expose_token() {
        let token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let first = stable_device_id(token);
        let second = stable_device_id(token);
        assert_eq!(first, second);
        assert!(first.starts_with("device-"));
        assert!(!first.contains(token));
    }
}

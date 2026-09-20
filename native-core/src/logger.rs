use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::verifier::{
    Confidence, EvidenceSource, PolicyDecision, ReasonCode, Verdict, VerificationResult,
};

const AUDIT_FILE_NAME: &str = "audit.jsonl";
const ROTATED_AUDIT_FILE_NAME: &str = "audit.1.jsonl";
const MAX_AUDIT_BYTES: u64 = 10 * 1024 * 1024;


const RUNTIME_FILE_NAME: &str = "runtime-current.jsonl";
const MAX_RUNTIME_FILE_BYTES: u64 = 1024 * 1024;
const RUNTIME_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone)]
pub struct RuntimeLogger {
    dir: PathBuf,
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl RuntimeLogger {
    pub fn new(logs_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&logs_dir).context("create GPTWork runtime log directory")?;
        let logger = Self {
            path: logs_dir.join(RUNTIME_FILE_NAME),
            dir: logs_dir,
            write_lock: Arc::new(Mutex::new(())),
        };
        logger.cleanup_expired()?;
        Ok(logger)
    }

    pub fn append_records(&self, records: &[Value]) -> Result<usize> {
        let _guard = self.write_lock.lock().map_err(|_| anyhow::anyhow!("runtime log lock is poisoned"))?;
        self.cleanup_expired()?;
        let mut written = 0usize;
        for record in records {
            let mut line = serde_json::to_vec(record).context("serialize GPTWork runtime record")?;
            line.push(b'\n');
            self.rotate_if_needed(line.len() as u64)?;
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            set_private_file_options(&mut options);
            let mut file = options.open(&self.path).context("open GPTWork runtime log")?;
            set_private_file_permissions(&file)?;
            file.write_all(&line).context("append GPTWork runtime log")?;
            file.flush().context("flush GPTWork runtime log")?;
            written += 1;
        }
        Ok(written)
    }

    fn rotate_if_needed(&self, incoming: u64) -> Result<()> {
        let current = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if current == 0 || current.saturating_add(incoming) <= MAX_RUNTIME_FILE_BYTES {
            return Ok(());
        }
        let stamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
        let rotated = self.dir.join(format!("runtime-{stamp}.jsonl"));
        fs::rename(&self.path, rotated).context("rotate GPTWork runtime log")?;
        Ok(())
    }

    fn cleanup_expired(&self) -> Result<()> {
        let now = SystemTime::now();
        for entry in fs::read_dir(&self.dir).context("scan GPTWork runtime log directory")? {
            let entry = entry?;
            let path = entry.path();
            if path == self.path || path.extension().and_then(|v| v.to_str()) != Some("jsonl") {
                continue;
            }
            if !path.file_name().and_then(|v| v.to_str()).is_some_and(|v| v.starts_with("runtime-")) {
                continue;
            }
            let modified = entry.metadata()?.modified().unwrap_or(now);
            if now.duration_since(modified).unwrap_or_default() > RUNTIME_RETENTION {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct AuditLogger {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl AuditLogger {
    pub fn new(logs_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&logs_dir).context("create GPTWork audit directory")?;
        Ok(Self {
            path: logs_dir.join(AUDIT_FILE_NAME),
            write_lock: Arc::new(Mutex::new(())),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn record_verification(&self, result: &VerificationResult) -> Result<()> {
        self.append(&VerificationAuditRecord {
            timestamp: result.verified_at,
            event: "verification",
            request_id: result.request_id.as_deref(),
            model: result.model.as_deref(),
            reasoning: result.reasoning.as_deref(),
            evidence_source: result.evidence_source,
            confidence: result.confidence,
            verdict: result.verdict,
            decision: result.decision,
            reasons: &result.reasons,
            policy_revision: &result.policy_revision,
        })
    }

    pub fn record_policy_update(&self, revision: &str, source: &str) -> Result<()> {
        self.append(&PolicyAuditRecord {
            timestamp: Utc::now(),
            event: "policy_update",
            source,
            policy_revision: revision,
        })
    }

    pub fn recent_records(&self, limit: usize) -> Result<Vec<Value>> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("audit log lock is poisoned"))?;
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).context("read GPTWork audit log"),
        };
        let limit = limit.clamp(1, 500);
        let mut records = contents
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .take(limit)
            .collect::<Vec<_>>();
        records.reverse();
        Ok(records)
    }

    fn append<T: Serialize>(&self, record: &T) -> Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("audit log lock is poisoned"))?;
        self.rotate_if_needed()?;

        let mut options = OpenOptions::new();
        options.create(true).append(true);
        set_private_file_options(&mut options);
        let mut file = options.open(&self.path).context("open GPTWork audit log")?;
        set_private_file_permissions(&file)?;
        serde_json::to_writer(&mut file, record).context("serialize GPTWork audit record")?;
        file.write_all(b"\n")
            .context("append GPTWork audit record")?;
        file.flush().context("flush GPTWork audit log")?;
        Ok(())
    }

    fn rotate_if_needed(&self) -> Result<()> {
        let Ok(metadata) = fs::metadata(&self.path) else {
            return Ok(());
        };
        if metadata.len() < MAX_AUDIT_BYTES {
            return Ok(());
        }

        let rotated = self.path.with_file_name(ROTATED_AUDIT_FILE_NAME);
        if rotated.exists() {
            fs::remove_file(&rotated).context("remove old GPTWork audit archive")?;
        }
        fs::rename(&self.path, &rotated).context("rotate GPTWork audit log")?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerificationAuditRecord<'a> {
    timestamp: DateTime<Utc>,
    event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<&'a str>,
    evidence_source: EvidenceSource,
    confidence: Confidence,
    verdict: Verdict,
    decision: PolicyDecision,
    reasons: &'a [ReasonCode],
    policy_revision: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PolicyAuditRecord<'a> {
    timestamp: DateTime<Utc>,
    event: &'static str,
    source: &'a str,
    policy_revision: &'a str,
}

#[cfg(unix)]
fn set_private_file_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_options(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_private_file_permissions(file: &std::fs::File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .context("secure GPTWork audit log")
}

#[cfg(not(unix))]
fn set_private_file_permissions(_file: &std::fs::File) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_logger_writes_jsonl_and_rotates_near_one_mib() {
        let temp = tempfile::tempdir().unwrap();
        let logger = RuntimeLogger::new(temp.path().to_path_buf()).unwrap();
        let payload = "x".repeat(70_000);
        for index in 0..18 {
            logger.append_records(&[json!({"index": index, "payload": payload})]).unwrap();
        }
        let files = fs::read_dir(temp.path()).unwrap().count();
        assert!(files >= 2);
        assert!(fs::metadata(temp.path().join(RUNTIME_FILE_NAME)).unwrap().len() <= MAX_RUNTIME_FILE_BYTES);
    }
}

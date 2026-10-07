use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::verifier::VerificationResult;

const POLICY_FILE_NAME: &str = "config.json";
const TOKEN_FILE_NAME: &str = "api.token";
const STATUS_FILE_NAME: &str = "status.json";
const LOGS_DIRECTORY_NAME: &str = "logs";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(default = "default_locked_models", alias = "models")]
    pub locked_models: Vec<String>,
    #[serde(default = "default_reasoning_levels", alias = "reasoningLevels")]
    pub allowed_reasoning_levels: Vec<String>,
    #[serde(default = "default_strict_mode")]
    pub strict_mode: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            locked_models: default_locked_models(),
            allowed_reasoning_levels: default_reasoning_levels(),
            strict_mode: default_strict_mode(),
        }
    }
}

impl Policy {
    pub fn normalized(mut self) -> Result<Self> {
        self.locked_models = normalize_unique(self.locked_models, normalize_model_id, "模型")?;
        self.allowed_reasoning_levels = normalize_unique(
            self.allowed_reasoning_levels,
            normalize_reasoning_level,
            "推理强度",
        )?;

        // An explicitly empty model list is the canonical "model lock disabled" state.
        // The extension intentionally reaches this state when the user clears the
        // server-authoritative catalog before running Discover Models. It must remain
        // a valid persistent policy rather than being misreported as a Core failure.
        if self.allowed_reasoning_levels.is_empty() {
            bail!("allowedReasoningLevels must contain at least one level / 至少选择一个推理强度");
        }
        if self.locked_models.len() > 32 || self.allowed_reasoning_levels.len() > 16 {
            bail!("policy contains too many entries / 策略条目数量过多");
        }

        Ok(self)
    }

    pub fn revision(&self) -> Result<String> {
        let bytes = serde_json::to_vec(self).context("serialize policy for revision")?;
        let mut hash = 0xcbf29ce484222325_u64;
        for byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        Ok(format!("{hash:016x}"))
    }
}

fn default_locked_models() -> Vec<String> {
    vec!["gpt-6-astra".to_owned(), "gpt-5.6-sol".to_owned()]
}

fn default_reasoning_levels() -> Vec<String> {
    vec![
        "medium".to_owned(),
        "high".to_owned(),
        "extra-high".to_owned(),
    ]
}

fn default_strict_mode() -> bool {
    true
}

fn normalize_unique<F>(values: Vec<String>, normalize: F, label: &str) -> Result<Vec<String>>
where
    F: Fn(&str) -> Result<String>,
{
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = normalize(&value).with_context(|| format!("invalid {label}: {value}"))?;
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

pub fn normalize_model_id(value: &str) -> Result<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        bail!("model id is empty / 模型标识不能为空");
    }
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        bail!("model id contains unsupported characters / 模型标识包含不支持的字符");
    }
    Ok(value)
}

pub fn normalize_reasoning_level(value: &str) -> Result<String> {
    let value = value.trim().to_ascii_lowercase();
    let normalized = match value.as_str() {
        "extra high" | "extra_high" | "extra-high" | "xhigh" => "extra-high".to_owned(),
        "low" | "medium" | "high" => value,
        _ => bail!("unsupported reasoning level / 不支持的推理强度: {value}"),
    };
    Ok(normalized)
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    root: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl ConfigStore {
    pub fn discover() -> Result<Self> {
        for variable in ["GPTWORK_HOME", "GPTLOCK_HOME"] {
            if let Some(override_root) = env::var_os(variable) {
                if override_root.is_empty() {
                    bail!("{variable} is empty");
                }
                return Ok(Self::at(PathBuf::from(override_root)));
            }
        }
        let home = if cfg!(windows) {
            env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))
        } else {
            env::var_os("HOME")
        }
        .context("cannot determine the current user's home directory")?;
        let home = PathBuf::from(home);
        let preferred = home.join(".gptwork");
        let legacy = home.join(".gptlock");
        Ok(Self::at(if preferred.exists() || !legacy.exists() {
            preferred
        } else {
            legacy
        }))
    }

    pub fn at(root: PathBuf) -> Self {
        Self {
            root,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn policy_path(&self) -> PathBuf {
        self.root.join(POLICY_FILE_NAME)
    }

    pub fn token_path(&self) -> PathBuf {
        self.root.join(TOKEN_FILE_NAME)
    }

    pub fn status_path(&self) -> PathBuf {
        self.root.join(STATUS_FILE_NAME)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join(LOGS_DIRECTORY_NAME)
    }

    pub fn initialize(&self) -> Result<()> {
        fs::create_dir_all(&self.root)
            .with_context(|| format!("create GPTWork directory {}", self.root.display()))?;
        set_private_directory_permissions(&self.root)?;
        fs::create_dir_all(self.logs_dir()).context("create GPTWork logs directory")?;
        set_private_directory_permissions(&self.logs_dir())?;

        if self.policy_path().exists() {
            let policy = self.load_policy()?;
            self.save_policy(policy)?;
        } else {
            self.save_policy(Policy::default())?;
        }
        Ok(())
    }

    pub fn load_policy(&self) -> Result<Policy> {
        let mut content = String::new();
        File::open(self.policy_path())
            .context("open GPTWork policy")?
            .read_to_string(&mut content)
            .context("read GPTWork policy")?;
        serde_json::from_str::<Policy>(&content)
            .context("parse GPTWork policy")?
            .normalized()
    }

    pub fn save_policy(&self, policy: Policy) -> Result<Policy> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("policy write lock is poisoned"))?;
        let policy = policy.normalized()?;
        let mut content = serde_json::to_vec_pretty(&policy).context("serialize GPTWork policy")?;
        content.push(b'\n');
        atomic_private_write(&self.policy_path(), &content)?;
        Ok(policy)
    }

    pub fn load_last_verification(&self) -> Result<Option<VerificationResult>> {
        match fs::read(self.status_path()) {
            Ok(content) => Ok(serde_json::from_slice(&content).ok()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).context("read GPTWork status snapshot"),
        }
    }

    pub fn save_last_verification(&self, result: &VerificationResult) -> Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("status write lock is poisoned"))?;
        let mut content =
            serde_json::to_vec_pretty(result).context("serialize GPTWork status snapshot")?;
        content.push(b'\n');
        atomic_private_write(&self.status_path(), &content)
    }

    pub fn load_or_create_api_token(&self) -> Result<String> {
        match fs::read_to_string(self.token_path()) {
            Ok(token) => {
                set_private_file_permissions(&self.token_path())?;
                validate_api_token(token.trim())
            }
            Err(error) if error.kind() == ErrorKind::NotFound => self.create_api_token(),
            Err(error) => Err(error).context("read GPTWork API token"),
        }
    }

    fn create_api_token(&self) -> Result<String> {
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_private_file_options(&mut options);

        match options.open(self.token_path()) {
            Ok(mut file) => {
                writeln!(file, "{token}").context("write GPTWork API token")?;
                file.sync_all().context("sync GPTWork API token")?;
                Ok(token)
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let existing = fs::read_to_string(self.token_path())
                    .context("read concurrently created GPTWork API token")?;
                validate_api_token(existing.trim())
            }
            Err(error) => Err(error).context("create GPTWork API token"),
        }
    }
}

fn validate_api_token(token: &str) -> Result<String> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("GPTWork API token file is invalid");
    }
    Ok(token.to_owned())
}

fn atomic_private_write(path: &Path, content: &[u8]) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid GPTWork file name")?;
    let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    set_private_file_options(&mut options);
    let mut file = options
        .open(&temporary)
        .with_context(|| format!("create temporary file {}", temporary.display()))?;
    file.write_all(content)
        .context("write temporary GPTWork file")?;
    file.sync_all().context("sync temporary GPTWork file")?;
    drop(file);

    fs::rename(&temporary, path)
        .with_context(|| format!("commit GPTWork file {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn set_private_file_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn set_private_file_options(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("secure directory {}", path.display()))
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("secure file {}", path.display()))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_prefers_astra_and_keeps_sol_fallback() {
        let policy = Policy::default();
        assert_eq!(policy.locked_models, ["gpt-6-astra", "gpt-5.6-sol"]);
    }

    #[test]
    fn legacy_policy_fields_are_migrated() {
        let policy: Policy = serde_json::from_str(
            r#"{"models":["GPT-5.6-SOL"],"reasoningLevels":["xhigh"],"strictMode":true}"#,
        )
        .unwrap();
        let policy = policy.normalized().unwrap();
        assert_eq!(policy.locked_models, ["gpt-5.6-sol"]);
        assert_eq!(policy.allowed_reasoning_levels, ["extra-high"]);
    }

    #[test]
    fn policy_revision_is_stable() {
        let first = Policy::default().revision().unwrap();
        let second = Policy::default().revision().unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn accepts_empty_model_policy_as_disabled_lock() {
        let policy = Policy {
            locked_models: Vec::new(),
            ..Policy::default()
        }
        .normalized()
        .unwrap();
        assert!(policy.locked_models.is_empty());
        assert!(!policy.allowed_reasoning_levels.is_empty());
    }
}

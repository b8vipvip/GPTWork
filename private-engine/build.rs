use std::{env, fs, path::PathBuf};

const KEY_ENV: &str = "GPTWORK_CAPABILITY_LEASE_PUBLIC_KEY_B64";
const REQUIRE_ENV: &str = "GPTWORK_REQUIRE_CAPABILITY_LEASE_KEY";
const KEY_FILE: &str = "capability-lease-public-key.txt";

fn normalize_key(value: &str, source: &str) -> Option<String> {
    let key = value.trim();
    if key.is_empty() {
        return None;
    }
    let valid = key.len() == 43
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !valid {
        panic!(
            "{source} must contain one raw 32-byte Ed25519 public key encoded as 43-character base64url without padding"
        );
    }
    Some(key.to_owned())
}

fn main() {
    println!("cargo:rerun-if-env-changed={KEY_ENV}");
    println!("cargo:rerun-if-env-changed={REQUIRE_ENV}");
    println!("cargo:rerun-if-env-changed=GITHUB_WORKFLOW");
    println!("cargo:rerun-if-changed={KEY_FILE}");

    let env_key = env::var(KEY_ENV)
        .ok()
        .and_then(|value| normalize_key(&value, KEY_ENV));

    let key_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is required"))
        .join(KEY_FILE);
    let file_key = match fs::read_to_string(&key_path) {
        Ok(value) => normalize_key(&value, KEY_FILE),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("failed to read {}: {error}", key_path.display()),
    };

    if let (Some(from_env), Some(from_file)) = (&env_key, &file_key) {
        if from_env != from_file {
            panic!("{KEY_ENV} does not match {KEY_FILE}");
        }
    }

    let key = env_key.or(file_key);
    if let Some(value) = &key {
        println!("cargo:rustc-env={KEY_ENV}={value}");
    }

    let release_required = env::var(REQUIRE_ENV).ok().as_deref() == Some("1")
        || env::var("GITHUB_WORKFLOW").ok().as_deref() == Some("Release");
    if release_required && key.is_none() {
        panic!(
            "production release blocked: configure {KEY_ENV} or commit the matching public key to private-engine/{KEY_FILE}"
        );
    }
}

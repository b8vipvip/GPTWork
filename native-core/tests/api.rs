use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use gptwork_core::api;
use gptwork_core::config::ConfigStore;
use gptwork_core::verifier::{EvidenceSource, VerificationRequest};
use gptwork_core::AppState;
use tower::ServiceExt;

fn test_state() -> (tempfile::TempDir, Arc<AppState>) {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::initialize(ConfigStore::at(directory.path().to_path_buf())).unwrap();
    (directory, state)
}

#[tokio::test]
async fn health_is_available_without_token() {
    let (_directory, state) = test_state();
    let response = api::app(state)
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn health_reports_degraded_when_policy_is_corrupt() {
    let (directory, state) = test_state();
    std::fs::write(directory.path().join("config.json"), b"not-json").unwrap();
    let response = api::app(state)
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn policy_rejects_missing_token() {
    let (_directory, state) = test_state();
    let response = api::app(state)
        .oneshot(Request::get("/policy").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn policy_accepts_bearer_token() {
    let (_directory, state) = test_state();
    let token = state.api_token().to_owned();
    let response = api::app(state)
        .oneshot(
            Request::get("/policy")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn dom_evidence_cannot_become_verified() {
    let (_directory, state) = test_state();
    let token = state.api_token().to_owned();
    let response = api::app(state)
        .oneshot(
            Request::post("/verify")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"model":"gpt-5.6-sol","reasoning":"high","evidenceSource":"page_dom"}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(result["verdict"], "unverified");
    assert_eq!(result["decision"], "warn");
}

#[tokio::test]
async fn empty_model_lock_policy_is_accepted() {
    let (_directory, state) = test_state();
    let token = state.api_token().to_owned();
    let response = api::app(state)
        .oneshot(
            Request::put("/policy")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"lockedModels":[],"allowedReasoningLevels":["high"],"strictMode":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[test]
fn verification_status_is_shared_between_process_instances() {
    let directory = tempfile::tempdir().unwrap();
    let store = ConfigStore::at(directory.path().to_path_buf());
    let first = AppState::initialize(store.clone()).unwrap();
    first
        .verify(VerificationRequest {
            model: Some("gpt-5.6-sol".to_owned()),
            reasoning: Some("high".to_owned()),
            evidence_source: EvidenceSource::NetworkResponseMetadata,
            captured_at: Some(chrono::Utc::now()),
            request_id: Some("shared-status".to_owned()),
        })
        .unwrap();
    drop(first);

    let second = AppState::initialize(store).unwrap();
    let status = second.status().unwrap();
    assert_eq!(
        status.last_verification.unwrap().request_id.as_deref(),
        Some("shared-status")
    );
}

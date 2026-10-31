//! The HTTP API: POST /check, POST /test and GET /environments, each behind the bearer token.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

use crate::protocol::{CheckRequest, TestRequest};
use crate::service::{Failure, Service};

/// A change carries whole files; a session's changes fit easily.
const MAX_BODY: usize = 16 * 1024 * 1024;

pub fn router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/check", post(check))
        .route("/test", post(test))
        .route("/environments", get(environments))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(service.clone(), authorize))
        .with_state(service)
}

/// Compares digests, so the comparison takes as long whatever the header holds.
async fn authorize(State(service): State<Arc<Service>>, request: Request, next: Next) -> Response {
    let digest = |text: &[u8]| Sha256::digest(text);
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .map_or(&b""[..], |value| value.as_bytes());
    let expected = digest(format!("Bearer {}", service.settings.token).as_bytes());
    let differs = digest(presented)
        .iter()
        .zip(expected.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if differs != 0 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

fn json<T: serde::Serialize>(value: &T) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/json".parse().expect("a header value"),
    );
    (
        headers,
        serde_json::to_string(value).expect("an answer serializes"),
    )
        .into_response()
}

fn failed(failure: Failure) -> Response {
    match failure {
        Failure::Fetch(message) => (StatusCode::BAD_GATEWAY, message).into_response(),
        Failure::ImageMissing(image) => {
            let message = format!(
                "The image {image} is missing and building it failed; see the service's log."
            );
            (StatusCode::SERVICE_UNAVAILABLE, message).into_response()
        }
        Failure::Internal(message) => {
            crate::log(&format!("internal error: {message}"));
            (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
        }
    }
}

fn parse<T: DeserializeOwned>(body: &Bytes) -> Result<T, Box<Response>> {
    serde_json::from_slice(body)
        .map_err(|error| Box::new((StatusCode::BAD_REQUEST, error.to_string()).into_response()))
}

// Each request runs in a task of its own, so a client hanging up leaves no tree half restored.
async fn check(State(service): State<Arc<Service>>, body: Bytes) -> Response {
    let request: CheckRequest = match parse(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let answer = tokio::spawn(async move { service.check(request).await }).await;
    match answer {
        Ok(Ok(answer)) => json(&answer),
        Ok(Err(failure)) => failed(failure),
        Err(panic) => failed(Failure::Internal(panic.to_string())),
    }
}

async fn test(State(service): State<Arc<Service>>, body: Bytes) -> Response {
    let request: TestRequest = match parse(&body) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let answer = tokio::spawn(async move { service.test(request).await }).await;
    match answer {
        Ok(Ok(answer)) => json(&answer),
        Ok(Err(failure)) => failed(failure),
        Err(panic) => failed(Failure::Internal(panic.to_string())),
    }
}

async fn environments(State(service): State<Arc<Service>>) -> Response {
    json(&service.environments.list())
}

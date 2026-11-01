//! The HTTP API: POST /check, POST /test and GET /environments, each behind the bearer token. POST /jobs/check and
//! POST /jobs/test run the same in the background and answer at once with an id; GET /jobs/{id} answers 202 until
//! the run ends, then as the plain endpoint would. A proxy in front, such as a Cloudflare tunnel, cuts off a request
//! after 100 s, and a busy checker queues runs for longer than that.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRef, Path, Request, State};
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

/// How long a finished job's answer waits to be collected.
const JOB_TTL: Duration = Duration::from_secs(30 * 60);

/// A background run's answer once it ends: its status, content type and body.
type Answer = (StatusCode, Option<header::HeaderValue>, Bytes);

#[derive(Default)]
struct Jobs(Mutex<HashMap<String, (Instant, Option<Answer>)>>);

#[derive(Clone)]
struct AppState {
    service: Arc<Service>,
    jobs: Arc<Jobs>,
}

impl FromRef<AppState> for Arc<Service> {
    fn from_ref(state: &AppState) -> Self {
        state.service.clone()
    }
}

pub fn router(service: Arc<Service>) -> Router {
    let state = AppState {
        service: service.clone(),
        jobs: Arc::default(),
    };
    Router::new()
        .route("/check", post(check))
        .route("/test", post(test))
        .route("/jobs/check", post(job_check))
        .route("/jobs/test", post(job_test))
        .route("/jobs/{id}", get(job))
        .route("/environments", get(environments))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(service, authorize))
        .with_state(state)
}

/// Starts `run` in the background and answers 202 with the id GET /jobs/{id} collects it by.
fn start<F>(jobs: Arc<Jobs>, run: F) -> Response
where
    F: std::future::Future<Output = Response> + Send + 'static,
{
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    {
        let mut table = jobs.0.lock().expect("the job table");
        table.retain(|_, (at, _)| at.elapsed() < JOB_TTL);
        table.insert(id.clone(), (Instant::now(), None));
    }
    let key = id.clone();
    tokio::spawn(async move {
        let response = run.await;
        let status = response.status();
        let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap_or_default();
        if let Some(entry) = jobs.0.lock().expect("the job table").get_mut(&key) {
            *entry = (Instant::now(), Some((status, content_type, body)));
        }
    });
    (StatusCode::ACCEPTED, json(&serde_json::json!({ "id": id }))).into_response()
}

async fn job_check(State(state): State<AppState>, body: Bytes) -> Response {
    start(state.jobs.clone(), check(State(state.service), body))
}

async fn job_test(State(state): State<AppState>, body: Bytes) -> Response {
    start(state.jobs.clone(), test(State(state.service), body))
}

/// 202 while the job runs; its answer once, after which the id is gone; 404 for an id the table does not hold.
async fn job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut table = state.jobs.0.lock().expect("the job table");
    match table.get(&id) {
        None => (StatusCode::NOT_FOUND, "no such job").into_response(),
        Some((_, None)) => (
            StatusCode::ACCEPTED,
            json(&serde_json::json!({ "status": "running" })),
        )
            .into_response(),
        Some((_, Some(_))) => {
            let Some((_, Some((status, content_type, body)))) = table.remove(&id) else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            let mut response = (status, body).into_response();
            if let Some(value) = content_type {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response
        }
    }
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

async fn environments(State(state): State<AppState>) -> Response {
    json(&state.service.environments.list())
}

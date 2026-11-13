pub mod api_types;
pub mod auth;
pub mod connectors;
pub mod crypto;
pub mod db;
pub mod engine;
pub mod http;
pub mod routes;
pub mod ssrf;
pub mod workflow;

use serde_json::Value;
use worker::{
    event, Context, Env, MessageBatch, Request, Response, Result, ScheduleContext, ScheduledEvent,
};

use crate::auth::csrf::verify_csrf;
use crate::http::{
    log_structured, new_request_id, AppError, MAX_API_BODY_BYTES, MAX_HOOK_BODY_BYTES,
};

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let request_id = new_request_id();
    let method = req.method();
    let path = req.path();

    if path.starts_with("/api/") {
        if let Err(reason) = verify_csrf(&req, &env) {
            log_structured(
                "warn",
                "csrf_rejected",
                &request_id,
                None,
                Some(403),
                Some(reason),
            );
            return AppError::Forbidden(reason.to_string()).into_response(&request_id);
        }

        if let Ok(Some(cl)) = req.headers().get("Content-Length") {
            if let Ok(len) = cl.trim().parse::<usize>() {
                if len > MAX_API_BODY_BYTES {
                    return AppError::PayloadTooLarge(format!(
                        "Request body exceeds {MAX_API_BODY_BYTES} byte limit."
                    ))
                    .into_response(&request_id);
                }
            }
        }
    } else if path.starts_with("/hooks/") {
        if let Ok(Some(cl)) = req.headers().get("Content-Length") {
            if let Ok(len) = cl.trim().parse::<usize>() {
                if len > MAX_HOOK_BODY_BYTES {
                    return AppError::PayloadTooLarge(format!(
                        "Request body exceeds {MAX_HOOK_BODY_BYTES} byte limit."
                    ))
                    .into_response(&request_id);
                }
            }
        }
    }

    let resp = routes::build_router(request_id.clone())
        .run(req, env)
        .await;

    match resp {
        Ok(r) => {
            log_structured(
                "info",
                "http_request",
                &request_id,
                None,
                Some(r.status_code()),
                Some(&format!("{method} {path}")),
            );
            Ok(r)
        }
        Err(e) => {
            log_structured(
                "error",
                "unhandled_worker_error",
                &request_id,
                None,
                Some(500),
                Some(&e.to_string()),
            );
            AppError::Internal(e.to_string()).into_response(&request_id)
        }
    }
}

#[event(queue)]
async fn queue(message_batch: MessageBatch<Value>, env: Env, _ctx: Context) -> Result<()> {
    engine::processor::handle_queue_batch(message_batch, env).await
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    engine::processor::scheduled_sweep(env).await;
}

use std::str::FromStr;

use worker::{Request, Response, RouteContext};

use crate::api_types::{Execution, ExecutionStatus};
use crate::db::{audit, d1, executions};
use crate::engine::processor::QueuePayload;
use crate::http::{authenticate, json_response, now_ms, AppError};

pub async fn list_executions(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;

    let url = req.url()?;
    let mut automation_id: Option<String> = None;
    let mut status: Option<ExecutionStatus> = None;
    let mut cursor: Option<String> = None;
    let mut limit: usize = 25;

    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "automationId" if !v.is_empty() => automation_id = Some(v.into_owned()),
            "status" if !v.is_empty() => {
                let parsed = ExecutionStatus::from_str(&v).map_err(|_| {
                    AppError::BadRequest(format!("Invalid execution status filter '{v}'."))
                })?;
                status = Some(parsed);
            }
            "cursor" if !v.is_empty() => cursor = Some(v.into_owned()),
            "limit" if !v.is_empty() => {
                limit = v.parse::<usize>().unwrap_or(25).clamp(1, 100);
            }
            _ => {}
        }
    }

    let db = d1(&ctx.env)?;
    let page = executions::list_executions(
        &db,
        &auth.org_id,
        automation_id.as_deref(),
        status,
        cursor.as_deref(),
        limit,
    )
    .await?;

    Ok(json_response(
        200,
        &page,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn get_execution(req: Request, ctx: RouteContext<String>) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Execution not found.".to_string()))?;

    let db = d1(&ctx.env)?;
    let row = executions::get_execution(&db, &auth.org_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Execution not found.".to_string()))?;

    let dto = Execution::try_from(row)?;
    Ok(json_response(
        200,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn retry_execution(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Execution not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let row = executions::get_execution(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Execution not found.".to_string()))?;

    if row.status != "failed" && row.status != "needs_review" {
        return Err(AppError::Conflict(
            "Only failed executions or executions needing review can be retried.".to_string(),
        ));
    }

    let updated = executions::reset_for_manual_retry(&db, &auth.org_id, &id).await?;
    if !updated {
        return Err(AppError::Conflict(
            "Execution is no longer in a retryable state.".to_string(),
        ));
    }

    let queue = ctx.env.queue("EXECUTIONS")?;
    queue
        .send(QueuePayload {
            event_id: row.event_id.clone(),
            automation_id: row.automation_id.clone(),
            org_id: auth.org_id.clone(),
            manual_retry: true,
        })
        .await?;

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "execution.retried",
        Some("execution"),
        Some(&id),
        None,
        now,
    )
    .await;

    let refreshed = executions::get_execution(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Execution not found.".to_string()))?;
    let dto = Execution::try_from(refreshed)?;

    Ok(json_response(
        202,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

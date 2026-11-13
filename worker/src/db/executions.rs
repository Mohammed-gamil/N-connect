use std::str::FromStr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine as _;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::D1Database;

use super::{d1_i64, d1_opt_i64, d1_opt_str, DbError};
use crate::api_types::{Execution, ExecutionStatus, Page, RecoveryAction};

#[derive(Debug, Clone, Deserialize)]
pub struct ExecutionRow {
    pub id: String,
    pub org_id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub event_id: String,
    pub status: String,
    pub attempt: i64,
    pub trigger_summary: Option<String>,
    pub action_summary: Option<String>,
    pub error_class: Option<String>,
    pub error_user_message: Option<String>,
    #[allow(dead_code)]
    pub error_detail: Option<String>,
    pub recovery: Option<String>,
    pub connection_id_needing_attention: Option<String>,
    pub external_ref: Option<String>,
    pub next_retry_at: Option<i64>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
}

impl TryFrom<ExecutionRow> for Execution {
    type Error = DbError;

    fn try_from(row: ExecutionRow) -> Result<Self, Self::Error> {
        let status = ExecutionStatus::from_str(&row.status).map_err(DbError::Integrity)?;
        let recovery = match row.recovery {
            Some(ref s) if !s.is_empty() => {
                Some(RecoveryAction::from_str(s).map_err(DbError::Integrity)?)
            }
            _ => None,
        };
        // Note: `error_detail` is intentionally NEVER mapped to the API DTO.
        Ok(Execution {
            id: row.id,
            automation_id: row.automation_id,
            automation_name: row.automation_name,
            status,
            attempt: row.attempt.max(0) as u32,
            trigger_summary: row.trigger_summary,
            action_summary: row.action_summary,
            error_message: row.error_user_message,
            recovery,
            connection_id_needing_attention: row.connection_id_needing_attention,
            started_at: row.started_at,
            finished_at: row.finished_at,
            duration_ms: row.duration_ms.map(|d| d.max(0) as u64),
        })
    }
}

fn encode_cursor(started_at: i64, id: &str) -> String {
    B64_URL.encode(format!("{started_at}:{id}"))
}

fn decode_cursor(cursor: &str) -> Option<(i64, String)> {
    let raw = B64_URL.decode(cursor).ok()?;
    let s = String::from_utf8(raw).ok()?;
    let (ts_str, id) = s.split_once(':')?;
    let ts: i64 = ts_str.parse().ok()?;
    Some((ts, id.to_string()))
}

pub async fn list_executions(
    db: &D1Database,
    org_id: &str,
    automation_id: Option<&str>,
    status: Option<ExecutionStatus>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Page<Execution>, DbError> {
    let clamped_limit = limit.clamp(1, 100);
    let fetch_limit = clamped_limit + 1;

    let mut sql = String::from(
        "SELECT e.id, e.org_id, e.automation_id, a.name AS automation_name, e.event_id,
                e.status, e.attempt, e.trigger_summary, e.action_summary,
                e.error_class, e.error_user_message, e.error_detail, e.recovery,
                e.connection_id_needing_attention, e.external_ref, e.next_retry_at,
                e.started_at, e.finished_at, e.duration_ms
         FROM execution_logs e
         JOIN automations a ON a.id = e.automation_id AND a.org_id = e.org_id
         WHERE e.org_id = ?1",
    );

    let mut params: Vec<JsValue> = vec![org_id.into()];
    let mut idx = 2usize;

    if let Some(aut_id) = automation_id.filter(|s| !s.is_empty()) {
        sql.push_str(&format!(" AND e.automation_id = ?{idx}"));
        params.push(aut_id.into());
        idx += 1;
    }

    if let Some(st) = status {
        sql.push_str(&format!(" AND e.status = ?{idx}"));
        params.push(st.as_str().into());
        idx += 1;
    }

    if let Some((cursor_ts, cursor_id)) = cursor.and_then(decode_cursor) {
        let p_ts = idx;
        let p_id = idx + 1;
        sql.push_str(&format!(
            " AND (COALESCE(e.started_at, 0) < ?{p_ts} OR (COALESCE(e.started_at, 0) = ?{p_ts} AND e.id < ?{p_id}))"
        ));
        params.push(d1_i64(cursor_ts));
        params.push(cursor_id.into());
        idx += 2;
    }

    sql.push_str(&format!(
        " ORDER BY COALESCE(e.started_at, 0) DESC, e.id DESC LIMIT ?{idx}"
    ));
    params.push((fetch_limit as f64).into());

    let res = db.prepare(&sql).bind(&params)?.all().await?;
    let mut rows: Vec<ExecutionRow> = res.results()?;

    let next_cursor = if rows.len() > clamped_limit {
        rows.truncate(clamped_limit);
        rows.last()
            .map(|last| encode_cursor(last.started_at.unwrap_or(0), &last.id))
    } else {
        None
    };

    let items = rows
        .into_iter()
        .map(Execution::try_from)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Page { items, next_cursor })
}

pub async fn get_execution(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<Option<ExecutionRow>, DbError> {
    let row = db
        .prepare(
            "SELECT e.id, e.org_id, e.automation_id, a.name AS automation_name, e.event_id,
                    e.status, e.attempt, e.trigger_summary, e.action_summary,
                    e.error_class, e.error_user_message, e.error_detail, e.recovery,
                    e.connection_id_needing_attention, e.external_ref, e.next_retry_at,
                    e.started_at, e.finished_at, e.duration_ms
             FROM execution_logs e
             JOIN automations a ON a.id = e.automation_id AND a.org_id = e.org_id
             WHERE e.id = ?1 AND e.org_id = ?2",
        )
        .bind(&[id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn get_execution_by_automation_event(
    db: &D1Database,
    org_id: &str,
    automation_id: &str,
    event_id: &str,
) -> Result<Option<ExecutionRow>, DbError> {
    let row = db
        .prepare(
            "SELECT e.id, e.org_id, e.automation_id, a.name AS automation_name, e.event_id,
                    e.status, e.attempt, e.trigger_summary, e.action_summary,
                    e.error_class, e.error_user_message, e.error_detail, e.recovery,
                    e.connection_id_needing_attention, e.external_ref, e.next_retry_at,
                    e.started_at, e.finished_at, e.duration_ms
             FROM execution_logs e
             JOIN automations a ON a.id = e.automation_id AND a.org_id = e.org_id
             WHERE e.org_id = ?1 AND e.automation_id = ?2 AND e.event_id = ?3",
        )
        .bind(&[org_id.into(), automation_id.into(), event_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn insert_execution_idempotent(
    db: &D1Database,
    org_id: &str,
    id: &str,
    automation_id: &str,
    event_id: &str,
    started_at: i64,
) -> Result<bool, DbError> {
    let res = db
        .prepare(
            "INSERT INTO execution_logs (id, org_id, automation_id, event_id, status, attempt, started_at)
             VALUES (?1, ?2, ?3, ?4, 'running', 0, ?5)
             ON CONFLICT(automation_id, event_id) DO NOTHING",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            automation_id.into(),
            event_id.into(),
            d1_i64(started_at),
        ])?
        .run()
        .await?;

    let changes = res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0);
    Ok(changes > 0)
}

pub async fn transition_to_running(
    db: &D1Database,
    org_id: &str,
    id: &str,
    started_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'running',
             attempt = attempt + 1,
             started_at = ?1,
             finished_at = NULL,
             duration_ms = NULL,
             error_class = NULL,
             error_user_message = NULL,
             error_detail = NULL,
             recovery = NULL,
             connection_id_needing_attention = NULL,
             next_retry_at = NULL
         WHERE id = ?2 AND org_id = ?3",
    )
    .bind(&[d1_i64(started_at), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_sending(
    db: &D1Database,
    org_id: &str,
    id: &str,
    trigger_summary: &str,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'sending', trigger_summary = ?1
         WHERE id = ?2 AND org_id = ?3",
    )
    .bind(&[trigger_summary.into(), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_filtered(
    db: &D1Database,
    org_id: &str,
    id: &str,
    trigger_summary: Option<&str>,
    finished_at: i64,
    duration_ms: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'filtered',
             trigger_summary = COALESCE(?1, trigger_summary),
             finished_at = ?2,
             duration_ms = ?3
         WHERE id = ?4 AND org_id = ?5",
    )
    .bind(&[
        d1_opt_str(trigger_summary),
        d1_i64(finished_at),
        d1_i64(duration_ms),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn mark_succeeded(
    db: &D1Database,
    org_id: &str,
    id: &str,
    trigger_summary: &str,
    action_summary: &str,
    external_ref: Option<&str>,
    finished_at: i64,
    duration_ms: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'succeeded',
             trigger_summary = ?1,
             action_summary = ?2,
             external_ref = ?3,
             error_class = NULL,
             error_user_message = NULL,
             error_detail = NULL,
             recovery = NULL,
             connection_id_needing_attention = NULL,
             next_retry_at = NULL,
             finished_at = ?4,
             duration_ms = ?5
         WHERE id = ?6 AND org_id = ?7",
    )
    .bind(&[
        trigger_summary.into(),
        action_summary.into(),
        d1_opt_str(external_ref),
        d1_i64(finished_at),
        d1_i64(duration_ms),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn mark_queued_for_retry(
    db: &D1Database,
    org_id: &str,
    id: &str,
    trigger_summary: Option<&str>,
    error_user_message: &str,
    error_detail: &str,
    next_retry_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'queued',
             trigger_summary = COALESCE(?1, trigger_summary),
             error_class = 'retryable',
             error_user_message = ?2,
             error_detail = ?3,
             recovery = 'retry',
             next_retry_at = ?4
         WHERE id = ?5 AND org_id = ?6",
    )
    .bind(&[
        d1_opt_str(trigger_summary),
        error_user_message.into(),
        error_detail.into(),
        d1_i64(next_retry_at),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn mark_failed(
    db: &D1Database,
    org_id: &str,
    id: &str,
    trigger_summary: Option<&str>,
    error_class: &str,
    error_user_message: &str,
    error_detail: &str,
    recovery: Option<&str>,
    connection_id_needing_attention: Option<&str>,
    finished_at: i64,
    duration_ms: Option<i64>,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'failed',
             trigger_summary = COALESCE(?1, trigger_summary),
             error_class = ?2,
             error_user_message = ?3,
             error_detail = ?4,
             recovery = ?5,
             connection_id_needing_attention = ?6,
             next_retry_at = NULL,
             finished_at = ?7,
             duration_ms = ?8
         WHERE id = ?9 AND org_id = ?10",
    )
    .bind(&[
        d1_opt_str(trigger_summary),
        error_class.into(),
        error_user_message.into(),
        error_detail.into(),
        d1_opt_str(recovery),
        d1_opt_str(connection_id_needing_attention),
        d1_i64(finished_at),
        d1_opt_i64(duration_ms),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_needs_review(
    db: &D1Database,
    org_id: &str,
    id: &str,
    error_user_message: &str,
    finished_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE execution_logs
         SET status = 'needs_review',
             error_class = 'unknown_outcome',
             error_user_message = ?1,
             recovery = 'retry',
             finished_at = ?2
         WHERE id = ?3 AND org_id = ?4",
    )
    .bind(&[
        error_user_message.into(),
        d1_i64(finished_at),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_dlq_failed(
    db: &D1Database,
    org_id: &str,
    automation_id: &str,
    event_id: &str,
    error_user_message: &str,
    finished_at: i64,
) -> Result<bool, DbError> {
    let res = db
        .prepare(
            "UPDATE execution_logs
             SET status = 'failed',
                 error_class = COALESCE(error_class, 'retryable'),
                 error_user_message = ?1,
                 recovery = 'retry',
                 next_retry_at = NULL,
                 finished_at = ?2
             WHERE org_id = ?3
               AND automation_id = ?4
               AND event_id = ?5
               AND status NOT IN ('succeeded', 'filtered', 'needs_review')",
        )
        .bind(&[
            error_user_message.into(),
            d1_i64(finished_at),
            org_id.into(),
            automation_id.into(),
            event_id.into(),
        ])?
        .run()
        .await?;

    let changes = res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0);
    Ok(changes > 0)
}

pub async fn reset_for_manual_retry(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<bool, DbError> {
    let res = db
        .prepare(
            "UPDATE execution_logs
             SET status = 'queued',
                 error_class = NULL,
                 error_user_message = NULL,
                 error_detail = NULL,
                 recovery = NULL,
                 connection_id_needing_attention = NULL,
                 next_retry_at = NULL,
                 finished_at = NULL,
                 duration_ms = NULL
             WHERE id = ?1 AND org_id = ?2 AND status IN ('failed', 'needs_review')",
        )
        .bind(&[id.into(), org_id.into()])?
        .run()
        .await?;

    let changes = res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0);
    Ok(changes > 0)
}

/// System-wide cron sweep across all organizations: marks executions stuck in `'sending'`
/// past `stale_before_ms` as `'needs_review'` so they are never automatically retried.
pub async fn sweep_stuck_sending_executions(
    db: &D1Database,
    error_user_message: &str,
    now_ms: i64,
    stale_before_ms: i64,
) -> Result<usize, DbError> {
    let res = db
        .prepare(
            "UPDATE execution_logs
             SET status = 'needs_review',
                 error_class = 'unknown_outcome',
                 error_user_message = ?1,
                 recovery = 'retry',
                 finished_at = ?2
             WHERE status = 'sending'
               AND started_at IS NOT NULL
               AND started_at < ?3",
        )
        .bind(&[
            error_user_message.into(),
            d1_i64(now_ms),
            d1_i64(stale_before_ms),
        ])?
        .run()
        .await?;

    let changes = res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0);
    Ok(changes)
}

#[derive(Debug, Deserialize)]
struct DashboardCountsRow {
    succeeded_cnt: Option<i64>,
    failed_cnt: Option<i64>,
}

pub async fn dashboard_execution_counts(
    db: &D1Database,
    org_id: &str,
    since_ms: i64,
) -> Result<(u64, u64), DbError> {
    let row: Option<DashboardCountsRow> = db
        .prepare(
            "SELECT
               SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_cnt,
               SUM(CASE WHEN status IN ('failed', 'needs_review') THEN 1 ELSE 0 END) AS failed_cnt
             FROM execution_logs
             WHERE org_id = ?1 AND COALESCE(started_at, 0) >= ?2",
        )
        .bind(&[org_id.into(), d1_i64(since_ms)])?
        .first(None)
        .await?;

    match row {
        Some(r) => Ok((
            r.succeeded_cnt.unwrap_or(0).max(0) as u64,
            r.failed_cnt.unwrap_or(0).max(0) as u64,
        )),
        None => Ok((0, 0)),
    }
}

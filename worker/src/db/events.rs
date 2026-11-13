use serde::Deserialize;
use worker::D1Database;

use super::{d1_i64, DbError};

#[derive(Debug, Clone, Deserialize)]
pub struct EventRow {
    pub id: String,
    pub org_id: String,
    pub subscription_id: String,
    pub dedup_key: String,
    pub payload_json: String,
    pub received_at: i64,
}

/// Inserts an event if `(subscription_id, dedup_key)` is not already present.
/// Returns `Ok(true)` if newly inserted, `Ok(false)` if deduplicated.
pub async fn insert_event_dedup(
    db: &D1Database,
    org_id: &str,
    id: &str,
    subscription_id: &str,
    dedup_key: &str,
    payload_json: &str,
    received_at: i64,
) -> Result<bool, DbError> {
    let res = db
        .prepare(
            "INSERT INTO events (id, org_id, subscription_id, dedup_key, payload_json, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(subscription_id, dedup_key) DO NOTHING",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            subscription_id.into(),
            dedup_key.into(),
            payload_json.into(),
            d1_i64(received_at),
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

pub async fn get_event(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<Option<EventRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, org_id, subscription_id, dedup_key, payload_json, received_at
             FROM events
             WHERE id = ?1 AND org_id = ?2",
        )
        .bind(&[id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn list_recent_samples(
    db: &D1Database,
    org_id: &str,
    subscription_id: &str,
    limit: usize,
) -> Result<Vec<EventRow>, DbError> {
    let res = db
        .prepare(
            "SELECT id, org_id, subscription_id, dedup_key, payload_json, received_at
             FROM events
             WHERE org_id = ?1 AND subscription_id = ?2
             ORDER BY received_at DESC
             LIMIT ?3",
        )
        .bind(&[org_id.into(), subscription_id.into(), (limit as f64).into()])?
        .all()
        .await?;
    Ok(res.results()?)
}

pub async fn get_latest_event_for_automation(
    db: &D1Database,
    org_id: &str,
    automation_id: &str,
) -> Result<Option<EventRow>, DbError> {
    let row = db
        .prepare(
            "SELECT e.id, e.org_id, e.subscription_id, e.dedup_key, e.payload_json, e.received_at
             FROM events e
             JOIN webhook_subscriptions ws
               ON ws.id = e.subscription_id AND ws.org_id = e.org_id
             WHERE e.org_id = ?1 AND ws.automation_id = ?2
             ORDER BY e.received_at DESC
             LIMIT 1",
        )
        .bind(&[org_id.into(), automation_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

use serde::Deserialize;
use worker::D1Database;

use super::{d1_i64, d1_opt_str, DbError};

#[derive(Debug, Clone, Deserialize)]
pub struct WebhookSubscriptionRow {
    pub id: String,
    pub org_id: String,
    pub automation_id: String,
    pub public_id: String,
    pub provider: String,
    pub external_webhook_id: Option<String>,
    pub secret_credential_id: Option<String>,
    pub verification: String,
    pub status: String,
    pub last_received_at: Option<i64>,
    pub created_at: i64,
}

/// Public webhook ingress lookup ONLY: `/hooks/:publicId` derives `org_id` from this row.
pub async fn find_by_public_id(
    db: &D1Database,
    public_id: &str,
) -> Result<Option<WebhookSubscriptionRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, org_id, automation_id, public_id, provider, external_webhook_id,
                    secret_credential_id, verification, status, last_received_at, created_at
             FROM webhook_subscriptions
             WHERE public_id = ?1",
        )
        .bind(&[public_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn get_by_automation(
    db: &D1Database,
    org_id: &str,
    automation_id: &str,
) -> Result<Option<WebhookSubscriptionRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, org_id, automation_id, public_id, provider, external_webhook_id,
                    secret_credential_id, verification, status, last_received_at, created_at
             FROM webhook_subscriptions
             WHERE automation_id = ?1 AND org_id = ?2 AND status != 'deleted'
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(&[automation_id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_subscription(
    db: &D1Database,
    org_id: &str,
    id: &str,
    automation_id: &str,
    public_id: &str,
    provider: &str,
    external_webhook_id: Option<&str>,
    secret_credential_id: Option<&str>,
    verification: &str,
    status: &str,
    created_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "INSERT INTO webhook_subscriptions
         (id, org_id, automation_id, public_id, provider, external_webhook_id, secret_credential_id, verification, status, last_received_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)",
    )
    .bind(&[
        id.into(),
        org_id.into(),
        automation_id.into(),
        public_id.into(),
        provider.into(),
        d1_opt_str(external_webhook_id),
        d1_opt_str(secret_credential_id),
        verification.into(),
        status.into(),
        d1_i64(created_at),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn list_active_by_automation(
    db: &D1Database,
    org_id: &str,
    automation_id: &str,
) -> Result<Vec<WebhookSubscriptionRow>, DbError> {
    let res = db
        .prepare(
            "SELECT id, org_id, automation_id, public_id, provider, external_webhook_id,
                    secret_credential_id, verification, status, last_received_at, created_at
             FROM webhook_subscriptions
             WHERE automation_id = ?1 AND org_id = ?2 AND status != 'deleted'
             ORDER BY created_at DESC",
        )
        .bind(&[automation_id.into(), org_id.into()])?
        .all()
        .await?;
    Ok(res.results()?)
}

pub async fn update_subscription_status(
    db: &D1Database,
    org_id: &str,
    id: &str,
    status: &str,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE webhook_subscriptions
         SET status = ?1
         WHERE id = ?2 AND org_id = ?3",
    )
    .bind(&[status.into(), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn update_subscription_config(
    db: &D1Database,
    org_id: &str,
    id: &str,
    verification: &str,
    secret_credential_id: Option<&str>,
    status: &str,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE webhook_subscriptions
         SET verification = ?1, secret_credential_id = ?2, status = ?3
         WHERE id = ?4 AND org_id = ?5",
    )
    .bind(&[
        verification.into(),
        d1_opt_str(secret_credential_id),
        status.into(),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn update_secret_credential_id(
    db: &D1Database,
    org_id: &str,
    id: &str,
    secret_credential_id: Option<&str>,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE webhook_subscriptions
         SET secret_credential_id = ?1
         WHERE id = ?2 AND org_id = ?3",
    )
    .bind(&[d1_opt_str(secret_credential_id), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn touch_last_received(
    db: &D1Database,
    org_id: &str,
    id: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE webhook_subscriptions
         SET last_received_at = ?1
         WHERE id = ?2 AND org_id = ?3",
    )
    .bind(&[d1_i64(now_ms), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_by_automation(
    db: &D1Database,
    org_id: &str,
    automation_id: &str,
) -> Result<(), DbError> {
    db.prepare(
        "DELETE FROM webhook_subscriptions
         WHERE automation_id = ?1 AND org_id = ?2",
    )
    .bind(&[automation_id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

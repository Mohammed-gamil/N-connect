use serde::Deserialize;
use worker::D1Database;

use super::{d1_blob, d1_i64, DbError};

#[derive(Debug, Clone, Deserialize)]
pub struct OrgOAuthAppRow {
    pub org_id: String,
    pub application_id: String,
    pub client_id: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: i32,
    pub updated_by: String,
    pub updated_at: i64,
}

pub async fn list_org_oauth_apps(
    db: &D1Database,
    org_id: &str,
) -> Result<Vec<OrgOAuthAppRow>, DbError> {
    let res = db
        .prepare(
            "SELECT org_id, application_id, client_id, ciphertext, nonce, key_version, updated_by, updated_at
             FROM org_oauth_apps
             WHERE org_id = ?1",
        )
        .bind(&[org_id.into()])?
        .all()
        .await?;
    Ok(res.results::<OrgOAuthAppRow>()?)
}

pub async fn get_org_oauth_app(
    db: &D1Database,
    org_id: &str,
    application_id: &str,
) -> Result<Option<OrgOAuthAppRow>, DbError> {
    let row = db
        .prepare(
            "SELECT org_id, application_id, client_id, ciphertext, nonce, key_version, updated_by, updated_at
             FROM org_oauth_apps
             WHERE org_id = ?1 AND application_id = ?2",
        )
        .bind(&[org_id.into(), application_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_org_oauth_app(
    db: &D1Database,
    org_id: &str,
    application_id: &str,
    client_id: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    key_version: i32,
    updated_by: &str,
    updated_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "INSERT INTO org_oauth_apps (org_id, application_id, client_id, ciphertext, nonce, key_version, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (org_id, application_id) DO UPDATE SET
           client_id = excluded.client_id,
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           key_version = excluded.key_version,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at",
    )
    .bind(&[
        org_id.into(),
        application_id.into(),
        client_id.into(),
        d1_blob(ciphertext),
        d1_blob(nonce),
        (key_version as f64).into(),
        updated_by.into(),
        d1_i64(updated_at),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_org_oauth_app(
    db: &D1Database,
    org_id: &str,
    application_id: &str,
) -> Result<bool, DbError> {
    let res = db
        .prepare(
            "DELETE FROM org_oauth_apps
             WHERE org_id = ?1 AND application_id = ?2",
        )
        .bind(&[org_id.into(), application_id.into()])?
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

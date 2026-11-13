use std::collections::HashMap;
use std::str::FromStr;

use serde::Deserialize;
use worker::D1Database;

use super::{d1_i64, d1_opt_str, DbError};
use crate::api_types::{AppId, Connection, ConnectionStatus};
use crate::workflow::validation::ConnectionMeta;

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectionRow {
    pub id: String,
    pub org_id: String,
    pub application_id: String,
    pub display_name: String,
    pub external_account_id: Option<String>,
    pub credential_id: String,
    pub status: String,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl TryFrom<ConnectionRow> for Connection {
    type Error = DbError;

    fn try_from(row: ConnectionRow) -> Result<Self, Self::Error> {
        let application_id = AppId::from_str(&row.application_id)
            .map_err(DbError::Integrity)?;
        let status = ConnectionStatus::from_str(&row.status)
            .map_err(DbError::Integrity)?;
        Ok(Connection {
            id: row.id,
            application_id,
            display_name: row.display_name,
            status,
            created_at: row.created_at,
        })
    }
}

pub async fn list_connections(db: &D1Database, org_id: &str) -> Result<Vec<ConnectionRow>, DbError> {
    let res = db
        .prepare(
            "SELECT id, org_id, application_id, display_name, external_account_id, credential_id, status, created_by, created_at, updated_at
             FROM connections
             WHERE org_id = ?1
             ORDER BY created_at DESC",
        )
        .bind(&[org_id.into()])?
        .all()
        .await?;
    Ok(res.results()?)
}

pub async fn list_connection_meta_map(
    db: &D1Database,
    org_id: &str,
) -> Result<HashMap<String, ConnectionMeta>, DbError> {
    let rows = list_connections(db, org_id).await?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        let app = AppId::from_str(&row.application_id).map_err(DbError::Integrity)?;
        let status = ConnectionStatus::from_str(&row.status).map_err(DbError::Integrity)?;
        map.insert(
            row.id,
            ConnectionMeta {
                application_id: app,
                status,
            },
        );
    }
    Ok(map)
}

pub async fn get_connection(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<Option<ConnectionRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, org_id, application_id, display_name, external_account_id, credential_id, status, created_by, created_at, updated_at
             FROM connections
             WHERE id = ?1 AND org_id = ?2",
        )
        .bind(&[id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn create_connection(
    db: &D1Database,
    org_id: &str,
    id: &str,
    application_id: AppId,
    display_name: &str,
    external_account_id: Option<&str>,
    credential_id: &str,
    status: ConnectionStatus,
    created_by: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    db.prepare(
        "INSERT INTO connections (id, org_id, application_id, display_name, external_account_id, credential_id, status, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
    )
    .bind(&[
        id.into(),
        org_id.into(),
        application_id.as_str().into(),
        display_name.into(),
        d1_opt_str(external_account_id),
        credential_id.into(),
        status.as_str().into(),
        created_by.into(),
        d1_i64(now_ms),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn update_connection_status(
    db: &D1Database,
    org_id: &str,
    id: &str,
    status: ConnectionStatus,
    now_ms: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE connections
         SET status = ?1, updated_at = ?2
         WHERE id = ?3 AND org_id = ?4",
    )
    .bind(&[status.as_str().into(), d1_i64(now_ms), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_connection(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<bool, DbError> {
    let existing = get_connection(db, org_id, id).await?;
    let Some(row) = existing else {
        return Ok(false);
    };

    let s1 = db
        .prepare("UPDATE automation_steps SET connection_id = NULL WHERE connection_id = ?1 AND org_id = ?2")
        .bind(&[id.into(), org_id.into()])?;
    let s2 = db
        .prepare("DELETE FROM connections WHERE id = ?1 AND org_id = ?2")
        .bind(&[id.into(), org_id.into()])?;
    let s3 = db
        .prepare("DELETE FROM credentials WHERE id = ?1 AND org_id = ?2")
        .bind(&[row.credential_id.as_str().into(), org_id.into()])?;

    let results = db.batch(vec![s1, s2, s3]).await?;
    for r in results {
        if let Some(err) = r.error() {
            return Err(DbError::Worker(worker::Error::RustError(err)));
        }
    }
    Ok(true)
}

#[derive(Debug, Deserialize)]
struct CountRow {
    cnt: i64,
}

pub async fn count_connected_apps(db: &D1Database, org_id: &str) -> Result<u64, DbError> {
    let row: Option<CountRow> = db
        .prepare(
            "SELECT COUNT(*) AS cnt
             FROM connections
             WHERE org_id = ?1 AND status = 'connected'",
        )
        .bind(&[org_id.into()])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.cnt.max(0) as u64).unwrap_or(0))
}

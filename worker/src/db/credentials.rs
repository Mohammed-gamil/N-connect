use serde::Deserialize;
use worker::D1Database;

use super::{d1_blob, d1_i64, DbError};

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialRow {
    pub id: String,
    pub org_id: String,
    pub kind: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: i32,
    pub created_at: i64,
    pub rotated_at: Option<i64>,
}

pub async fn insert_credential(
    db: &D1Database,
    id: &str,
    org_id: &str,
    kind: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    key_version: i32,
    created_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "INSERT INTO credentials (id, org_id, kind, ciphertext, nonce, key_version, created_at, rotated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
    )
    .bind(&[
        id.into(),
        org_id.into(),
        kind.into(),
        d1_blob(ciphertext),
        d1_blob(nonce),
        (key_version as f64).into(),
        d1_i64(created_at),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn get_credential(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<Option<CredentialRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, org_id, kind, ciphertext, nonce, key_version, created_at, rotated_at
             FROM credentials
             WHERE id = ?1 AND org_id = ?2",
        )
        .bind(&[id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn rotate_credential(
    db: &D1Database,
    org_id: &str,
    id: &str,
    ciphertext: &[u8],
    nonce: &[u8],
    key_version: i32,
    rotated_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE credentials
         SET ciphertext = ?1, nonce = ?2, key_version = ?3, rotated_at = ?4
         WHERE id = ?5 AND org_id = ?6",
    )
    .bind(&[
        d1_blob(ciphertext),
        d1_blob(nonce),
        (key_version as f64).into(),
        d1_i64(rotated_at),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_credential(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<(), DbError> {
    db.prepare(
        "DELETE FROM credentials
         WHERE id = ?1 AND org_id = ?2",
    )
    .bind(&[id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

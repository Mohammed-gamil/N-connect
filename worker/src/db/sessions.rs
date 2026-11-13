use serde::Deserialize;
use worker::D1Database;

use super::{d1_i64, DbError};

#[derive(Debug, Clone, Deserialize)]
pub struct SessionRow {
    pub token_hash: String,
    pub user_id: String,
    pub org_id: String,
    pub expires_at: i64,
    pub created_at: i64,
}

pub async fn create_session(
    db: &D1Database,
    token_hash: &str,
    user_id: &str,
    org_id: &str,
    expires_at: i64,
    created_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "INSERT INTO sessions (token_hash, user_id, org_id, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&[
        token_hash.into(),
        user_id.into(),
        org_id.into(),
        d1_i64(expires_at),
        d1_i64(created_at),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn find_valid_session(
    db: &D1Database,
    token_hash: &str,
    now_ms: i64,
) -> Result<Option<SessionRow>, DbError> {
    let row = db
        .prepare(
            "SELECT token_hash, user_id, org_id, expires_at, created_at
             FROM sessions
             WHERE token_hash = ?1 AND expires_at > ?2",
        )
        .bind(&[token_hash.into(), d1_i64(now_ms)])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn touch_session_expiry(
    db: &D1Database,
    token_hash: &str,
    org_id: &str,
    new_expires_at: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE sessions
         SET expires_at = ?1
         WHERE token_hash = ?2 AND org_id = ?3",
    )
    .bind(&[d1_i64(new_expires_at), token_hash.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_session(
    db: &D1Database,
    token_hash: &str,
    org_id: &str,
) -> Result<(), DbError> {
    db.prepare(
        "DELETE FROM sessions
         WHERE token_hash = ?1 AND org_id = ?2",
    )
    .bind(&[token_hash.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn cleanup_expired_sessions(db: &D1Database, now_ms: i64) -> Result<(), DbError> {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1")
        .bind(&[d1_i64(now_ms)])?
        .run()
        .await?;
    Ok(())
}

pub async fn cleanup_expired_oauth_states(db: &D1Database, now_ms: i64) -> Result<(), DbError> {
    db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?1")
        .bind(&[d1_i64(now_ms)])?
        .run()
        .await?;
    Ok(())
}

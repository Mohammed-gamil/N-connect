use serde::Deserialize;
use worker::{D1Database, Request};

use crate::db::{d1_i64, DbError};

pub const LOGIN_WINDOW_MS: i64 = 15 * 60 * 1000;
pub const LOGIN_MAX_FAILURES: i64 = 5;

pub const REGISTER_WINDOW_MS: i64 = 60 * 60 * 1000;
pub const REGISTER_MAX_ATTEMPTS: i64 = 10;

#[derive(Debug, Deserialize)]
struct RateLimitRow {
    count: i64,
    window_start: i64,
}

pub fn client_ip(req: &Request) -> String {
    if let Ok(Some(ip)) = req.headers().get("CF-Connecting-IP") {
        let trimmed = ip.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(Some(xff)) = req.headers().get("X-Forwarded-For") {
        if let Some(first) = xff.split(',').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "unknown".to_string()
}

pub fn login_rate_limit_key(email: &str, ip: &str) -> String {
    format!("login:{}:{}", ip, email.trim().to_lowercase())
}

pub fn register_rate_limit_key(ip: &str) -> String {
    format!("register:{ip}")
}

/// Returns `Ok(true)` if allowed, `Ok(false)` if currently rate limited.
pub async fn is_within_limit(
    db: &D1Database,
    key: &str,
    max_count: i64,
    window_ms: i64,
    now_ms: i64,
) -> Result<bool, DbError> {
    let row: Option<RateLimitRow> = db
        .prepare("SELECT count, window_start FROM rate_limits WHERE key = ?1")
        .bind(&[key.into()])?
        .first(None)
        .await?;

    let Some(row) = row else {
        return Ok(true);
    };

    if now_ms - row.window_start >= window_ms {
        return Ok(true);
    }

    Ok(row.count < max_count)
}

/// Increments a fixed-window counter and returns the new count.
pub async fn increment_limit(
    db: &D1Database,
    key: &str,
    window_ms: i64,
    now_ms: i64,
) -> Result<i64, DbError> {
    let row: Option<RateLimitRow> = db
        .prepare(
            "INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
             ON CONFLICT(key) DO UPDATE SET
               count = CASE WHEN (?2 - rate_limits.window_start) >= ?3 THEN 1 ELSE rate_limits.count + 1 END,
               window_start = CASE WHEN (?2 - rate_limits.window_start) >= ?3 THEN ?2 ELSE rate_limits.window_start END
             RETURNING count, window_start",
        )
        .bind(&[key.into(), d1_i64(now_ms), d1_i64(window_ms)])?
        .first(None)
        .await?;

    Ok(row.map(|r| r.count).unwrap_or(1))
}

pub async fn clear_limit(db: &D1Database, key: &str) -> Result<(), DbError> {
    db.prepare("DELETE FROM rate_limits WHERE key = ?1")
        .bind(&[key.into()])?
        .run()
        .await?;
    Ok(())
}

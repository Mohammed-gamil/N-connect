use serde::Deserialize;
use worker::D1Database;

use super::{d1_i64, DbError};
use crate::api_types::{Me, MeOrganization, MeUser};

#[derive(Debug, Clone, Deserialize)]
pub struct UserRow {
    pub id: String,
    pub email: String,
    pub password_hash: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MembershipRow {
    pub org_id: String,
    pub org_name: String,
    pub user_id: String,
    pub user_name: String,
    pub user_email: String,
    pub role: String,
}

impl From<MembershipRow> for Me {
    fn from(row: MembershipRow) -> Self {
        Self {
            user: MeUser {
                id: row.user_id,
                name: row.user_name,
                email: row.user_email,
            },
            organization: MeOrganization {
                id: row.org_id,
                name: row.org_name,
            },
        }
    }
}

pub async fn find_user_by_email(db: &D1Database, email: &str) -> Result<Option<UserRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, email, password_hash, name, created_at
             FROM users
             WHERE email = ?1",
        )
        .bind(&[email.trim().into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn find_default_membership_for_user(
    db: &D1Database,
    user_id: &str,
) -> Result<Option<MembershipRow>, DbError> {
    let row = db
        .prepare(
            "SELECT m.org_id, o.name AS org_name, m.user_id, u.name AS user_name, u.email AS user_email, m.role
             FROM memberships m
             JOIN organizations o ON o.id = m.org_id
             JOIN users u ON u.id = m.user_id
             WHERE m.user_id = ?1
             ORDER BY o.created_at ASC
             LIMIT 1",
        )
        .bind(&[user_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn find_user_and_org_by_id(
    db: &D1Database,
    user_id: &str,
    org_id: &str,
) -> Result<Option<MembershipRow>, DbError> {
    let row = db
        .prepare(
            "SELECT m.org_id, o.name AS org_name, m.user_id, u.name AS user_name, u.email AS user_email, m.role
             FROM memberships m
             JOIN organizations o ON o.id = m.org_id
             JOIN users u ON u.id = m.user_id
             WHERE m.user_id = ?1 AND m.org_id = ?2",
        )
        .bind(&[user_id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn create_user_with_personal_org(
    db: &D1Database,
    user_id: &str,
    email: &str,
    password_hash: &str,
    name: &str,
    org_id: &str,
    org_name: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    let s1 = db
        .prepare(
            "INSERT INTO users (id, email, password_hash, name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(&[
            user_id.into(),
            email.trim().into(),
            password_hash.into(),
            name.trim().into(),
            d1_i64(now_ms),
        ])?;

    let s2 = db
        .prepare(
            "INSERT INTO organizations (id, name, created_at)
             VALUES (?1, ?2, ?3)",
        )
        .bind(&[org_id.into(), org_name.into(), d1_i64(now_ms)])?;

    let s3 = db
        .prepare(
            "INSERT INTO memberships (org_id, user_id, role)
             VALUES (?1, ?2, 'owner')",
        )
        .bind(&[org_id.into(), user_id.into()])?;

    let results = db.batch(vec![s1, s2, s3]).await?;
    for r in results {
        if let Some(err) = r.error() {
            return Err(DbError::Worker(worker::Error::RustError(err)));
        }
    }
    Ok(())
}

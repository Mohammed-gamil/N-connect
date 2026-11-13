use worker::D1Database;

use super::{d1_i64, d1_opt_str, DbError};
use crate::crypto::{new_id, PREFIX_AUDIT};

#[allow(clippy::too_many_arguments)]
pub async fn insert_audit_log(
    db: &D1Database,
    org_id: &str,
    user_id: Option<&str>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    metadata_json: Option<&str>,
    created_at: i64,
) -> Result<(), DbError> {
    let id = new_id(PREFIX_AUDIT).map_err(|e| DbError::Integrity(e.to_string()))?;
    db.prepare(
        "INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&[
        id.into(),
        org_id.into(),
        d1_opt_str(user_id),
        action.into(),
        d1_opt_str(target_type),
        d1_opt_str(target_id),
        d1_opt_str(metadata_json),
        d1_i64(created_at),
    ])?
    .run()
    .await?;
    Ok(())
}

use std::str::FromStr;

use serde::Deserialize;
use worker::D1Database;

use super::{d1_i64, d1_opt_str, DbError};
use crate::api_types::{
    Automation, AutomationLayout, AutomationStatus, ExecutionStatus, WorkflowDefinitionV1,
};
use crate::connectors::Catalog;
use crate::workflow::summary::summarize_workflow;

#[derive(Debug, Clone, Deserialize)]
pub struct AutomationRow {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub status: String,
    pub definition_version: i32,
    pub definition_json: String,
    pub layout_json: Option<String>,
    pub last_execution_at: Option<i64>,
    pub last_execution_status: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AutomationRow {
    pub fn into_dto(self, catalog: &Catalog) -> Result<Automation, DbError> {
        let status = AutomationStatus::from_str(&self.status).map_err(DbError::Integrity)?;
        let definition: WorkflowDefinitionV1 = serde_json::from_str(&self.definition_json)
            .map_err(|e| DbError::Integrity(format!("invalid definition_json: {e}")))?;
        let layout: Option<AutomationLayout> = match self.layout_json {
            Some(ref s) if !s.is_empty() => Some(
                serde_json::from_str(s)
                    .map_err(|e| DbError::Integrity(format!("invalid layout_json: {e}")))?,
            ),
            _ => None,
        };
        let last_execution_status = match self.last_execution_status {
            Some(ref s) if !s.is_empty() => {
                Some(ExecutionStatus::from_str(s).map_err(DbError::Integrity)?)
            }
            _ => None,
        };
        let summary = summarize_workflow(&definition, catalog);
        Ok(Automation {
            id: self.id,
            name: self.name,
            status,
            definition,
            layout,
            summary,
            last_execution_at: self.last_execution_at,
            last_execution_status,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

pub async fn list_automations(db: &D1Database, org_id: &str) -> Result<Vec<AutomationRow>, DbError> {
    let res = db
        .prepare(
            "SELECT id, org_id, name, status, definition_version, definition_json, layout_json,
                    last_execution_at, last_execution_status, created_by, created_at, updated_at
             FROM automations
             WHERE org_id = ?1
             ORDER BY updated_at DESC",
        )
        .bind(&[org_id.into()])?
        .all()
        .await?;
    Ok(res.results()?)
}

pub async fn get_automation(
    db: &D1Database,
    org_id: &str,
    id: &str,
) -> Result<Option<AutomationRow>, DbError> {
    let row = db
        .prepare(
            "SELECT id, org_id, name, status, definition_version, definition_json, layout_json,
                    last_execution_at, last_execution_status, created_by, created_at, updated_at
             FROM automations
             WHERE id = ?1 AND org_id = ?2",
        )
        .bind(&[id.into(), org_id.into()])?
        .first(None)
        .await?;
    Ok(row)
}

pub async fn insert_automation_with_steps(
    db: &D1Database,
    org_id: &str,
    id: &str,
    name: &str,
    status: AutomationStatus,
    def: &WorkflowDefinitionV1,
    layout: Option<&AutomationLayout>,
    created_by: &str,
    now_ms: i64,
) -> Result<(), DbError> {
    let def_json = serde_json::to_string(def)
        .map_err(|e| DbError::Integrity(format!("serialize definition: {e}")))?;
    let layout_json = layout
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| DbError::Integrity(format!("serialize layout: {e}")))?;

    let s1 = db
        .prepare(
            "INSERT INTO automations (id, org_id, name, status, definition_version, definition_json, layout_json,
                                      last_execution_at, last_execution_status, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?9)",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            name.into(),
            status.as_str().into(),
            (def.version as f64).into(),
            def_json.into(),
            d1_opt_str(layout_json.as_deref()),
            created_by.into(),
            d1_i64(now_ms),
        ])?;

    let s2 = db
        .prepare(
            "INSERT INTO automation_steps (automation_id, org_id, kind, application_id, event, connection_id)
             VALUES (?1, ?2, 'trigger', ?3, ?4, ?5)",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            def.trigger.application.as_str().into(),
            def.trigger.event.as_str().into(),
            d1_opt_str(def.trigger.connection_id.as_deref()),
        ])?;

    let s3 = db
        .prepare(
            "INSERT INTO automation_steps (automation_id, org_id, kind, application_id, event, connection_id)
             VALUES (?1, ?2, 'action', ?3, ?4, ?5)",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            def.action.application.as_str().into(),
            def.action.event.as_str().into(),
            d1_opt_str(def.action.connection_id.as_deref()),
        ])?;

    let results = db.batch(vec![s1, s2, s3]).await?;
    for r in results {
        if let Some(err) = r.error() {
            return Err(DbError::Worker(worker::Error::RustError(err)));
        }
    }
    Ok(())
}

pub async fn update_automation_with_steps(
    db: &D1Database,
    org_id: &str,
    id: &str,
    name: &str,
    def: &WorkflowDefinitionV1,
    layout: Option<&AutomationLayout>,
    now_ms: i64,
) -> Result<(), DbError> {
    let def_json = serde_json::to_string(def)
        .map_err(|e| DbError::Integrity(format!("serialize definition: {e}")))?;
    let layout_json = layout
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| DbError::Integrity(format!("serialize layout: {e}")))?;

    let s1 = db
        .prepare(
            "UPDATE automations
             SET name = ?1, definition_version = ?2, definition_json = ?3, layout_json = ?4, updated_at = ?5
             WHERE id = ?6 AND org_id = ?7",
        )
        .bind(&[
            name.into(),
            (def.version as f64).into(),
            def_json.into(),
            d1_opt_str(layout_json.as_deref()),
            d1_i64(now_ms),
            id.into(),
            org_id.into(),
        ])?;

    let s2 = db
        .prepare(
            "INSERT INTO automation_steps (automation_id, org_id, kind, application_id, event, connection_id)
             VALUES (?1, ?2, 'trigger', ?3, ?4, ?5)
             ON CONFLICT(automation_id, kind) DO UPDATE SET
               application_id = excluded.application_id,
               event = excluded.event,
               connection_id = excluded.connection_id
             WHERE automation_steps.org_id = ?2",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            def.trigger.application.as_str().into(),
            def.trigger.event.as_str().into(),
            d1_opt_str(def.trigger.connection_id.as_deref()),
        ])?;

    let s3 = db
        .prepare(
            "INSERT INTO automation_steps (automation_id, org_id, kind, application_id, event, connection_id)
             VALUES (?1, ?2, 'action', ?3, ?4, ?5)
             ON CONFLICT(automation_id, kind) DO UPDATE SET
               application_id = excluded.application_id,
               event = excluded.event,
               connection_id = excluded.connection_id
             WHERE automation_steps.org_id = ?2",
        )
        .bind(&[
            id.into(),
            org_id.into(),
            def.action.application.as_str().into(),
            def.action.event.as_str().into(),
            d1_opt_str(def.action.connection_id.as_deref()),
        ])?;

    let results = db.batch(vec![s1, s2, s3]).await?;
    for r in results {
        if let Some(err) = r.error() {
            return Err(DbError::Worker(worker::Error::RustError(err)));
        }
    }
    Ok(())
}

pub async fn update_automation_status(
    db: &D1Database,
    org_id: &str,
    id: &str,
    status: AutomationStatus,
    now_ms: i64,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE automations
         SET status = ?1, updated_at = ?2
         WHERE id = ?3 AND org_id = ?4",
    )
    .bind(&[status.as_str().into(), d1_i64(now_ms), id.into(), org_id.into()])?
    .run()
    .await?;
    Ok(())
}

pub async fn update_last_execution(
    db: &D1Database,
    org_id: &str,
    id: &str,
    last_execution_at: i64,
    last_execution_status: ExecutionStatus,
) -> Result<(), DbError> {
    db.prepare(
        "UPDATE automations
         SET last_execution_at = ?1, last_execution_status = ?2
         WHERE id = ?3 AND org_id = ?4",
    )
    .bind(&[
        d1_i64(last_execution_at),
        last_execution_status.as_str().into(),
        id.into(),
        org_id.into(),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn delete_automation(db: &D1Database, org_id: &str, id: &str) -> Result<bool, DbError> {
    let existing = get_automation(db, org_id, id).await?;
    if existing.is_none() {
        return Ok(false);
    }

    let s1 = db
        .prepare("DELETE FROM webhook_subscriptions WHERE automation_id = ?1 AND org_id = ?2")
        .bind(&[id.into(), org_id.into()])?;
    let s2 = db
        .prepare("DELETE FROM automation_steps WHERE automation_id = ?1 AND org_id = ?2")
        .bind(&[id.into(), org_id.into()])?;
    let s3 = db
        .prepare("DELETE FROM automations WHERE id = ?1 AND org_id = ?2")
        .bind(&[id.into(), org_id.into()])?;

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

pub async fn count_active_automations(db: &D1Database, org_id: &str) -> Result<u64, DbError> {
    let row: Option<CountRow> = db
        .prepare(
            "SELECT COUNT(*) AS cnt
             FROM automations
             WHERE org_id = ?1 AND status = 'active'",
        )
        .bind(&[org_id.into()])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.cnt.max(0) as u64).unwrap_or(0))
}

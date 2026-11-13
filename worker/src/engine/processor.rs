use std::collections::BTreeMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use worker::{Env, MessageBatch, MessageExt as _, QueueRetryOptionsBuilder};

use crate::api_types::{
    AppId, ConfigValue, ConnectionStatus, ExecutionStatus, KeyValuePair, WorkflowDefinitionV1,
};
use crate::connectors::{
    get_connector, ActionConfig, Catalog, ConnectorError, Cx, ErrorClass, RenderedInputs,
    TriggerConfig,
};
use crate::crypto::{decrypt_secret, load_master_key, make_credential_aad, new_id, Secret, PREFIX_EXECUTION};
use crate::db::{automations, connections, credentials, d1, events, executions};
use crate::engine::retry;
use crate::http::{log_structured, now_ms};
use crate::workflow::filters::evaluate_filters;
use crate::workflow::template::{render_template, EscapeMode};

pub const DLQ_QUEUE_NAME: &str = "hub-executions-dlq";
pub const UNKNOWN_OUTCOME_USER_MESSAGE: &str = "We started sending this action, then lost connection before hearing back. Check the destination app before clicking Try again so you don't send a duplicate.";
pub const DLQ_FAILED_USER_MESSAGE: &str =
    "This run failed after multiple automatic retries. You can try again below.";
const STUCK_SENDING_THRESHOLD_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePayload {
    pub event_id: String,
    pub automation_id: String,
    pub org_id: String,
    #[serde(default)]
    pub manual_retry: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessOutcome {
    Ack,
    Retry { delay_secs: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreExecDecision {
    Proceed,
    NoOpAck,
    MarkNeedsReviewAndAck,
}

/// Pure idempotency state machine decision before executing a workflow run.
pub fn decide_pre_execution(status: ExecutionStatus) -> PreExecDecision {
    match status {
        ExecutionStatus::Succeeded
        | ExecutionStatus::Filtered
        | ExecutionStatus::NeedsReview => PreExecDecision::NoOpAck,
        ExecutionStatus::Sending => PreExecDecision::MarkNeedsReviewAndAck,
        ExecutionStatus::Queued | ExecutionStatus::Running | ExecutionStatus::Failed => {
            PreExecDecision::Proceed
        }
    }
}

/// Synthesizes sample variables from the trigger's `VariableDefinition::example` fields.
pub fn synthesize_sample_variables(
    def: &WorkflowDefinitionV1,
    catalog: &Catalog,
) -> Map<String, Value> {
    let mut vars = Map::new();
    let trigger_def = catalog
        .get_trigger(def.trigger.application, &def.trigger.event)
        .or_else(|| {
            catalog
                .get_app(def.trigger.application)
                .and_then(|app| app.triggers.first())
        });

    if let Some(td) = trigger_def {
        for v in &td.variables {
            vars.insert(v.path.clone(), Value::String(v.example.clone()));
        }
    }
    vars
}

fn looks_like_json_body(headers: &[KeyValuePair], body: &str) -> bool {
    let ct_is_json = headers.iter().any(|p| {
        p.key.eq_ignore_ascii_case("Content-Type")
            && p.value.to_ascii_lowercase().contains("json")
    });
    if ct_is_json {
        return true;
    }
    let trimmed = body.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

/// Renders action configuration fields using template variables and per-connector escape modes.
pub fn render_action_inputs(
    def: &WorkflowDefinitionV1,
    vars: &Map<String, Value>,
) -> RenderedInputs {
    let mut values: BTreeMap<String, ConfigValue> = BTreeMap::new();

    match def.action.application {
        AppId::Slack => {
            for (k, v) in &def.action.configuration {
                if k == "message" {
                    if let ConfigValue::String(tpl) = v {
                        values.insert(
                            k.clone(),
                            ConfigValue::String(render_template(tpl, vars, EscapeMode::Slack)),
                        );
                        continue;
                    }
                }
                values.insert(k.clone(), v.clone());
            }
        }
        AppId::Http => {
            let mut rendered_headers: Vec<KeyValuePair> = Vec::new();
            if let Some(ConfigValue::KeyValueList(pairs)) = def.action.configuration.get("headers") {
                for p in pairs {
                    rendered_headers.push(KeyValuePair {
                        key: p.key.clone(),
                        value: render_template(&p.value, vars, EscapeMode::None),
                    });
                }
            }

            for (k, v) in &def.action.configuration {
                match (k.as_str(), v) {
                    ("url", ConfigValue::String(tpl)) => {
                        values.insert(
                            k.clone(),
                            ConfigValue::String(render_template(tpl, vars, EscapeMode::None)),
                        );
                    }
                    ("headers", ConfigValue::KeyValueList(_)) => {
                        values.insert(
                            k.clone(),
                            ConfigValue::KeyValueList(rendered_headers.clone()),
                        );
                    }
                    ("body", ConfigValue::String(tpl)) => {
                        let mode = if looks_like_json_body(&rendered_headers, tpl) {
                            EscapeMode::JsonString
                        } else {
                            EscapeMode::None
                        };
                        values.insert(
                            k.clone(),
                            ConfigValue::String(render_template(tpl, vars, mode)),
                        );
                    }
                    _ => {
                        values.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        _ => {
            values = def.action.configuration.clone();
        }
    }

    RenderedInputs { values }
}

async fn load_connection_secret(
    env: &Env,
    db: &worker::D1Database,
    org_id: &str,
    connection_id: &str,
) -> Result<Result<Secret, ConnectorError>, worker::Error> {
    let conn = match connections::get_connection(db, org_id, connection_id).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Ok(Err(ConnectorError::needs_reconnect(
                "The selected connection was deleted. Reconnect an account and try again.",
                format!("missing connection {connection_id}"),
            )));
        }
        Err(e) => return Err(worker::Error::RustError(e.to_string())),
    };

    let cred = match credentials::get_credential(db, org_id, &conn.credential_id).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Ok(Err(ConnectorError::needs_reconnect(
                "Saved credentials are missing. Reconnect your account and try again.",
                format!("missing credential {} for connection {connection_id}", conn.credential_id),
            )));
        }
        Err(e) => return Err(worker::Error::RustError(e.to_string())),
    };

    let master_key = match load_master_key(env, cred.key_version) {
        Ok(k) => k,
        Err(e) => {
            return Ok(Err(ConnectorError::permanent(
                "Unable to access saved credentials.",
                e.to_string(),
            )));
        }
    };
    let aad = make_credential_aad(org_id, &cred.id, &cred.kind);
    match decrypt_secret(&master_key, &cred.ciphertext, &cred.nonce, &aad) {
        Ok(sec) => Ok(Ok(sec)),
        Err(e) => Ok(Err(ConnectorError::needs_reconnect(
            "Saved credentials could not be unlocked. Please reconnect your account.",
            e.to_string(),
        ))),
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_connector_failure(
    db: &worker::D1Database,
    org_id: &str,
    execution_id: &str,
    automation_id: &str,
    attempt_started_at: i64,
    delivery_attempt: u32,
    trigger_summary: Option<&str>,
    connection_id: Option<&str>,
    conn_err: ConnectorError,
) -> Result<ProcessOutcome, worker::Error> {
    let now = now_ms();

    if conn_err.class == ErrorClass::NeedsReconnect {
        if let Some(cid) = connection_id {
            let _ = connections::update_connection_status(
                db,
                org_id,
                cid,
                ConnectionStatus::NeedsAttention,
                now,
            )
            .await;
        }
    }

    if let ErrorClass::Retryable { retry_after_secs } = conn_err.class {
        if delivery_attempt < 5 {
            let delay_secs = retry::backoff_seconds(delivery_attempt, retry_after_secs);
            let next_retry_at = now + (delay_secs as i64) * 1000;
            executions::mark_queued_for_retry(
                db,
                org_id,
                execution_id,
                trigger_summary,
                &conn_err.user_message,
                &conn_err.internal_detail,
                next_retry_at,
            )
            .await
            .map_err(|e| worker::Error::RustError(e.to_string()))?;

            log_structured(
                "warn",
                "execution_scheduled_retry",
                execution_id,
                Some(org_id),
                None,
                Some(&format!(
                    "automation={} attempt={} delay_secs={} detail={}",
                    automation_id, delivery_attempt, delay_secs, conn_err.internal_detail
                )),
            );

            return Ok(ProcessOutcome::Retry { delay_secs });
        }
    }

    let duration_ms = (now - attempt_started_at).max(0);
    let recovery = conn_err.class.recovery().map(|r| r.as_str());
    let conn_attention = if conn_err.class == ErrorClass::NeedsReconnect {
        connection_id
    } else {
        None
    };

    executions::mark_failed(
        db,
        org_id,
        execution_id,
        trigger_summary,
        conn_err.class.as_str(),
        &conn_err.user_message,
        &conn_err.internal_detail,
        recovery,
        conn_attention,
        now,
        Some(duration_ms),
    )
    .await
    .map_err(|e| worker::Error::RustError(e.to_string()))?;

    let _ = automations::update_last_execution(
        db,
        org_id,
        automation_id,
        now,
        ExecutionStatus::Failed,
    )
    .await;

    log_structured(
        "warn",
        "execution_failed",
        execution_id,
        Some(org_id),
        None,
        Some(&format!(
            "automation={} class={} detail={}",
            automation_id,
            conn_err.class.as_str(),
            conn_err.internal_detail
        )),
    );

    Ok(ProcessOutcome::Ack)
}

pub async fn process_execution_message(
    env: &Env,
    payload: QueuePayload,
    delivery_attempt: u32,
) -> Result<ProcessOutcome, worker::Error> {
    let db = d1(env).map_err(|e| worker::Error::RustError(e.to_string()))?;

    let Some(automation) = automations::get_automation(&db, &payload.org_id, &payload.automation_id)
        .await
        .map_err(|e| worker::Error::RustError(e.to_string()))?
    else {
        log_structured(
            "warn",
            "execution_missing_automation",
            "queue",
            Some(&payload.org_id),
            None,
            Some(&payload.automation_id),
        );
        return Ok(ProcessOutcome::Ack);
    };

    let Some(event) = events::get_event(&db, &payload.org_id, &payload.event_id)
        .await
        .map_err(|e| worker::Error::RustError(e.to_string()))?
    else {
        log_structured(
            "warn",
            "execution_missing_event",
            "queue",
            Some(&payload.org_id),
            None,
            Some(&payload.event_id),
        );
        return Ok(ProcessOutcome::Ack);
    };

    if automation.status != "active" && !payload.manual_retry {
        return Ok(ProcessOutcome::Ack);
    }

    let now = now_ms();
    let new_exec_id = new_id(PREFIX_EXECUTION).map_err(|e| worker::Error::RustError(e.to_string()))?;
    executions::insert_execution_idempotent(
        &db,
        &payload.org_id,
        &new_exec_id,
        &payload.automation_id,
        &payload.event_id,
        now,
    )
    .await
    .map_err(|e| worker::Error::RustError(e.to_string()))?;

    let Some(exec_row) = executions::get_execution_by_automation_event(
        &db,
        &payload.org_id,
        &payload.automation_id,
        &payload.event_id,
    )
    .await
    .map_err(|e| worker::Error::RustError(e.to_string()))?
    else {
        return Err(worker::Error::RustError(
            "execution_logs row missing after idempotent insert".to_string(),
        ));
    };

    let current_status = ExecutionStatus::from_str(&exec_row.status)
        .map_err(worker::Error::RustError)?;

    match decide_pre_execution(current_status) {
        PreExecDecision::NoOpAck => return Ok(ProcessOutcome::Ack),
        PreExecDecision::MarkNeedsReviewAndAck => {
            executions::mark_needs_review(
                &db,
                &payload.org_id,
                &exec_row.id,
                UNKNOWN_OUTCOME_USER_MESSAGE,
                now,
            )
            .await
            .map_err(|e| worker::Error::RustError(e.to_string()))?;
            let _ = automations::update_last_execution(
                &db,
                &payload.org_id,
                &payload.automation_id,
                now,
                ExecutionStatus::NeedsReview,
            )
            .await;
            return Ok(ProcessOutcome::Ack);
        }
        PreExecDecision::Proceed => {}
    }

    let attempt_started_at = now_ms();
    executions::transition_to_running(&db, &payload.org_id, &exec_row.id, attempt_started_at)
        .await
        .map_err(|e| worker::Error::RustError(e.to_string()))?;

    let def: WorkflowDefinitionV1 = match serde_json::from_str(&automation.definition_json) {
        Ok(d) => d,
        Err(e) => {
            let err = ConnectorError::permanent(
                "This automation's configuration is invalid.",
                format!("invalid definition_json: {e}"),
            );
            return handle_connector_failure(
                &db,
                &payload.org_id,
                &exec_row.id,
                &payload.automation_id,
                attempt_started_at,
                delivery_attempt,
                None,
                None,
                err,
            )
            .await;
        }
    };

    let raw_json: Value = match serde_json::from_str(&event.payload_json) {
        Ok(v) => v,
        Err(e) => {
            let err = ConnectorError::permanent(
                "The incoming event payload could not be read.",
                format!("invalid event payload_json: {e}"),
            );
            return handle_connector_failure(
                &db,
                &payload.org_id,
                &exec_row.id,
                &payload.automation_id,
                attempt_started_at,
                delivery_attempt,
                None,
                None,
                err,
            )
            .await;
        }
    };

    let cx = Cx {
        env,
        org_id: &payload.org_id,
        request_id: &exec_row.id,
    };

    // Load trigger credentials if trigger uses a connection
    let trigger_creds = if let Some(ref conn_id) = def.trigger.connection_id {
        match load_connection_secret(env, &db, &payload.org_id, conn_id).await? {
            Ok(s) => s,
            Err(conn_err) => {
                return handle_connector_failure(
                    &db,
                    &payload.org_id,
                    &exec_row.id,
                    &payload.automation_id,
                    attempt_started_at,
                    delivery_attempt,
                    None,
                    Some(conn_id.as_str()),
                    conn_err,
                )
                .await;
            }
        }
    } else {
        Secret::from_bytes(Vec::new())
    };

    let trigger_connector = get_connector(def.trigger.application);
    let trigger_cfg = TriggerConfig {
        event: def.trigger.event.clone(),
        configuration: def.trigger.configuration.clone(),
    };

    let normalized = match trigger_connector
        .normalize(&cx, &trigger_creds, &trigger_cfg, &raw_json)
        .await
    {
        Ok(Some(n)) => n,
        Ok(None) => {
            let finished = now_ms();
            let dur = (finished - attempt_started_at).max(0);
            executions::mark_filtered(&db, &payload.org_id, &exec_row.id, None, finished, dur)
                .await
                .map_err(|e| worker::Error::RustError(e.to_string()))?;
            return Ok(ProcessOutcome::Ack);
        }
        Err(conn_err) => {
            return handle_connector_failure(
                &db,
                &payload.org_id,
                &exec_row.id,
                &payload.automation_id,
                attempt_started_at,
                delivery_attempt,
                None,
                def.trigger.connection_id.as_deref(),
                conn_err,
            )
            .await;
        }
    };

    if !evaluate_filters(&def.filters, &normalized.variables) {
        let finished = now_ms();
        let dur = (finished - attempt_started_at).max(0);
        executions::mark_filtered(
            &db,
            &payload.org_id,
            &exec_row.id,
            Some(&normalized.trigger_summary),
            finished,
            dur,
        )
        .await
        .map_err(|e| worker::Error::RustError(e.to_string()))?;
        return Ok(ProcessOutcome::Ack);
    }

    let rendered_inputs = render_action_inputs(&def, &normalized.variables);

    let action_creds = if let Some(ref conn_id) = def.action.connection_id {
        match load_connection_secret(env, &db, &payload.org_id, conn_id).await? {
            Ok(s) => s,
            Err(conn_err) => {
                return handle_connector_failure(
                    &db,
                    &payload.org_id,
                    &exec_row.id,
                    &payload.automation_id,
                    attempt_started_at,
                    delivery_attempt,
                    Some(&normalized.trigger_summary),
                    Some(conn_id.as_str()),
                    conn_err,
                )
                .await;
            }
        }
    } else {
        Secret::from_bytes(Vec::new())
    };

    // CRITICAL: Record status = 'sending' BEFORE invoking the external action so crashes never
    // result in silent automatic retries that could duplicate side effects.
    executions::mark_sending(
        &db,
        &payload.org_id,
        &exec_row.id,
        &normalized.trigger_summary,
    )
    .await
    .map_err(|e| worker::Error::RustError(e.to_string()))?;

    let action_connector = get_connector(def.action.application);
    let action_cfg = ActionConfig {
        event: def.action.event.clone(),
        configuration: def.action.configuration.clone(),
    };

    match action_connector
        .execute(&cx, &action_creds, &action_cfg, &rendered_inputs)
        .await
    {
        Ok(output) => {
            let finished = now_ms();
            let dur = (finished - attempt_started_at).max(0);
            executions::mark_succeeded(
                &db,
                &payload.org_id,
                &exec_row.id,
                &normalized.trigger_summary,
                &output.action_summary,
                output.external_ref.as_deref(),
                finished,
                dur,
            )
            .await
            .map_err(|e| worker::Error::RustError(e.to_string()))?;

            let _ = automations::update_last_execution(
                &db,
                &payload.org_id,
                &payload.automation_id,
                finished,
                ExecutionStatus::Succeeded,
            )
            .await;

            log_structured(
                "info",
                "execution_succeeded",
                &exec_row.id,
                Some(&payload.org_id),
                None,
                Some(&format!("automation={} duration_ms={dur}", payload.automation_id)),
            );

            Ok(ProcessOutcome::Ack)
        }
        Err(conn_err) => {
            handle_connector_failure(
                &db,
                &payload.org_id,
                &exec_row.id,
                &payload.automation_id,
                attempt_started_at,
                delivery_attempt,
                Some(&normalized.trigger_summary),
                def.action.connection_id.as_deref(),
                conn_err,
            )
            .await
        }
    }
}

pub async fn handle_queue_batch(
    batch: MessageBatch<Value>,
    env: Env,
) -> worker::Result<()> {
    let queue_name = batch.queue();
    if queue_name == DLQ_QUEUE_NAME {
        let db = d1(&env).map_err(|e| worker::Error::RustError(e.to_string()))?;
        for msg in batch.iter() {
            match msg {
                Ok(m) => {
                    if let Ok(payload) = serde_json::from_value::<QueuePayload>(m.body().clone()) {
                        let now = now_ms();
                        match executions::mark_dlq_failed(
                            &db,
                            &payload.org_id,
                            &payload.automation_id,
                            &payload.event_id,
                            DLQ_FAILED_USER_MESSAGE,
                            now,
                        )
                        .await
                        {
                            Ok(true) => {
                                let _ = automations::update_last_execution(
                                    &db,
                                    &payload.org_id,
                                    &payload.automation_id,
                                    now,
                                    ExecutionStatus::Failed,
                                )
                                .await;
                            }
                            Ok(false) => {}
                            Err(e) => {
                                log_structured(
                                    "error",
                                    "dlq_update_failed",
                                    "dlq",
                                    Some(&payload.org_id),
                                    None,
                                    Some(&e.to_string()),
                                );
                            }
                        }
                    }
                    m.ack();
                }
                Err(e) => {
                    log_structured(
                        "error",
                        "dlq_message_decode_error",
                        "dlq",
                        None,
                        None,
                        Some(&e.to_string()),
                    );
                }
            }
        }
        return Ok(());
    }

    for msg in batch.iter() {
        match msg {
            Ok(m) => {
                let payload = match serde_json::from_value::<QueuePayload>(m.body().clone()) {
                    Ok(p) => p,
                    Err(e) => {
                        log_structured(
                            "error",
                            "queue_payload_invalid",
                            "queue",
                            None,
                            None,
                            Some(&e.to_string()),
                        );
                        m.ack();
                        continue;
                    }
                };
                let delivery_attempt = m.attempts();
                match process_execution_message(&env, payload, delivery_attempt).await {
                    Ok(ProcessOutcome::Ack) => m.ack(),
                    Ok(ProcessOutcome::Retry { delay_secs }) => {
                        let opts = QueueRetryOptionsBuilder::new()
                            .with_delay_seconds(delay_secs as u32)
                            .build();
                        m.retry_with_options(&opts);
                    }
                    Err(e) => {
                        log_structured(
                            "error",
                            "queue_processing_error",
                            "queue",
                            None,
                            None,
                            Some(&e.to_string()),
                        );
                        if delivery_attempt < 5 {
                            let delay = retry::backoff_seconds(delivery_attempt, None);
                            let opts = QueueRetryOptionsBuilder::new()
                                .with_delay_seconds(delay as u32)
                                .build();
                            m.retry_with_options(&opts);
                        } else {
                            m.retry();
                        }
                    }
                }
            }
            Err(e) => {
                log_structured(
                    "error",
                    "queue_message_decode_error",
                    "queue",
                    None,
                    None,
                    Some(&e.to_string()),
                );
            }
        }
    }

    Ok(())
}

pub async fn scheduled_sweep(env: Env) {
    let now = now_ms();
    match d1(&env) {
        Ok(db) => {
            if let Err(e) = crate::db::sessions::cleanup_expired_sessions(&db, now).await {
                log_structured(
                    "error",
                    "cron_cleanup_sessions_failed",
                    "cron",
                    None,
                    None,
                    Some(&e.to_string()),
                );
            }
            if let Err(e) = crate::db::sessions::cleanup_expired_oauth_states(&db, now).await {
                log_structured(
                    "error",
                    "cron_cleanup_oauth_states_failed",
                    "cron",
                    None,
                    None,
                    Some(&e.to_string()),
                );
            }
            match executions::sweep_stuck_sending_executions(
                &db,
                UNKNOWN_OUTCOME_USER_MESSAGE,
                now,
                now - STUCK_SENDING_THRESHOLD_MS,
            )
            .await
            {
                Ok(swept) if swept > 0 => {
                    log_structured(
                        "warn",
                        "cron_swept_stuck_sending",
                        "cron",
                        None,
                        None,
                        Some(&format!("swept={swept}")),
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    log_structured(
                        "error",
                        "cron_sweep_stuck_sending_failed",
                        "cron",
                        None,
                        None,
                        Some(&e.to_string()),
                    );
                }
            }
        }
        Err(e) => {
            log_structured(
                "error",
                "cron_db_binding_failed",
                "cron",
                None,
                None,
                Some(&e.to_string()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{SelectConfigValue, WorkflowStep};
    use serde_json::json;

    #[test]
    fn idempotency_state_machine_decisions() {
        assert_eq!(
            decide_pre_execution(ExecutionStatus::Succeeded),
            PreExecDecision::NoOpAck
        );
        assert_eq!(
            decide_pre_execution(ExecutionStatus::Filtered),
            PreExecDecision::NoOpAck
        );
        assert_eq!(
            decide_pre_execution(ExecutionStatus::NeedsReview),
            PreExecDecision::NoOpAck
        );
        assert_eq!(
            decide_pre_execution(ExecutionStatus::Sending),
            PreExecDecision::MarkNeedsReviewAndAck
        );
        assert_eq!(
            decide_pre_execution(ExecutionStatus::Queued),
            PreExecDecision::Proceed
        );
        assert_eq!(
            decide_pre_execution(ExecutionStatus::Running),
            PreExecDecision::Proceed
        );
        assert_eq!(
            decide_pre_execution(ExecutionStatus::Failed),
            PreExecDecision::Proceed
        );
    }

    #[test]
    fn synthesizes_sample_variables_from_catalog_examples() {
        let catalog = Catalog::mvp();
        let def = WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Clickup,
                event: "task.created".to_string(),
                connection_id: Some("con_1".to_string()),
                configuration: BTreeMap::new(),
            },
            filters: vec![],
            action: WorkflowStep {
                application: AppId::Slack,
                event: "message.send".to_string(),
                connection_id: Some("con_2".to_string()),
                configuration: BTreeMap::new(),
            },
        };

        let vars = synthesize_sample_variables(&def, &catalog);
        assert_eq!(vars["task.name"], json!("Ship the new onboarding"));
        assert_eq!(
            vars["task.url"],
            json!("https://app.clickup.com/t/8688abc12")
        );
        assert_eq!(vars["event.type"], json!("taskCreated"));
        assert_eq!(vars.len(), 11);
    }

    #[test]
    fn renders_slack_and_http_inputs_with_proper_escaping() {
        let mut vars = Map::new();
        vars.insert("task.name".to_string(), json!("Fix <bug> & \"quote\""));

        let mut slack_cfg = BTreeMap::new();
        slack_cfg.insert(
            "channel".to_string(),
            ConfigValue::Select(SelectConfigValue {
                value: "C1".to_string(),
                label: "#eng".to_string(),
            }),
        );
        slack_cfg.insert(
            "message".to_string(),
            ConfigValue::String("New: {{task.name}}".to_string()),
        );
        let slack_wf = WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Clickup,
                event: "task.created".to_string(),
                connection_id: None,
                configuration: BTreeMap::new(),
            },
            filters: vec![],
            action: WorkflowStep {
                application: AppId::Slack,
                event: "message.send".to_string(),
                connection_id: None,
                configuration: slack_cfg,
            },
        };
        let rendered_slack = render_action_inputs(&slack_wf, &vars);
        assert_eq!(
            rendered_slack.values.get("message").and_then(|v| v.as_str()),
            Some("New: Fix &lt;bug&gt; &amp; \"quote\"")
        );

        let mut http_cfg = BTreeMap::new();
        http_cfg.insert(
            "url".to_string(),
            ConfigValue::String("https://example.com/{{task.name}}".to_string()),
        );
        http_cfg.insert(
            "headers".to_string(),
            ConfigValue::KeyValueList(vec![KeyValuePair {
                key: "X-Task".to_string(),
                value: "{{task.name}}".to_string(),
            }]),
        );
        http_cfg.insert(
            "body".to_string(),
            ConfigValue::String(r#"{"name":"{{task.name}}"}"#.to_string()),
        );
        let http_wf = WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Clickup,
                event: "task.created".to_string(),
                connection_id: None,
                configuration: BTreeMap::new(),
            },
            filters: vec![],
            action: WorkflowStep {
                application: AppId::Http,
                event: "http.request".to_string(),
                connection_id: None,
                configuration: http_cfg,
            },
        };
        let rendered_http = render_action_inputs(&http_wf, &vars);
        let rendered_body = rendered_http
            .values
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap();
        let parsed_body: Value = serde_json::from_str(rendered_body).unwrap();
        assert_eq!(parsed_body["name"], "Fix <bug> & \"quote\"");
        assert_eq!(
            rendered_http.values.get("url").and_then(|v| v.as_str()),
            Some("https://example.com/Fix <bug> & \"quote\"")
        );
    }
}

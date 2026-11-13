use std::collections::{BTreeMap, HashMap};

use crate::api_types::{
    AppId, AuthKind, ConfigValue, ConnectionStatus, FieldDefinition, FieldType,
    FilterOp, WorkflowDefinitionV1,
};
use crate::connectors::Catalog;
use crate::workflow::template::{extract_template_vars, is_valid_var_path};

const MAX_FILTERS: usize = 20;
const MAX_CONFIG_TEXT_LEN: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionMeta {
    pub application_id: AppId,
    pub status: ConnectionStatus,
}

/// Validates a draft workflow per `docs/API.md`:
/// - `version == 1`
/// - `trigger.event` / `action.event` may be empty `""`, but if non-empty must exist in the catalog
/// - any `connectionId` present must exist in the org and belong to the matching application
/// - filter count/path syntax and config value sizes are bounded
pub fn validate_draft(
    def: &WorkflowDefinitionV1,
    catalog: &Catalog,
    owned_connections: &HashMap<String, ConnectionMeta>,
) -> Result<(), BTreeMap<String, String>> {
    let mut errors = BTreeMap::new();

    if def.version != 1 {
        errors.insert(
            "version".to_string(),
            "Unsupported workflow version; expected version 1.".to_string(),
        );
    }

    validate_step_common(
        "trigger",
        &def.trigger.application,
        &def.trigger.event,
        def.trigger.connection_id.as_deref(),
        &def.trigger.configuration,
        true,
        catalog,
        owned_connections,
        &mut errors,
    );

    validate_step_common(
        "action",
        &def.action.application,
        &def.action.event,
        def.action.connection_id.as_deref(),
        &def.action.configuration,
        false,
        catalog,
        owned_connections,
        &mut errors,
    );

    if def.filters.len() > MAX_FILTERS {
        errors.insert(
            "filters".to_string(),
            format!("At most {MAX_FILTERS} filters are allowed."),
        );
    }

    for (idx, f) in def.filters.iter().enumerate() {
        if !f.path.is_empty() && !is_valid_var_path(&f.path) {
            errors.insert(
                format!("filters.{idx}.path"),
                "Invalid variable path.".to_string(),
            );
        }
        if let Some(ref val) = f.value {
            if val.len() > 1024 {
                errors.insert(
                    format!("filters.{idx}.value"),
                    "Filter value is too long.".to_string(),
                );
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Validates an automation for activation per `docs/API.md`:
/// - All draft checks pass
/// - Trigger & action events are non-empty and exist in catalog
/// - Required connections exist in org, match app, and have status `connected`
/// - All required configuration fields are present and non-empty
/// - All `{{variable}}` placeholders in action templates exist in the trigger's variable schema
/// - All filter paths exist in the trigger's variable schema
pub fn validate_active(
    def: &WorkflowDefinitionV1,
    catalog: &Catalog,
    owned_connections: &HashMap<String, ConnectionMeta>,
) -> Result<(), BTreeMap<String, String>> {
    let mut errors = match validate_draft(def, catalog, owned_connections) {
        Ok(()) => BTreeMap::new(),
        Err(errs) => errs,
    };

    let trigger_app = catalog.get_app(def.trigger.application);
    let action_app = catalog.get_app(def.action.application);

    if def.trigger.event.trim().is_empty() {
        errors.insert(
            "trigger.event".to_string(),
            "Please select a trigger event.".to_string(),
        );
    }
    if def.action.event.trim().is_empty() {
        errors.insert(
            "action.event".to_string(),
            "Please select an action event.".to_string(),
        );
    }

    if let Some(app) = trigger_app {
        validate_active_connection(
            "trigger.connectionId",
            app.auth_kind,
            def.trigger.application,
            def.trigger.connection_id.as_deref(),
            owned_connections,
            &mut errors,
        );
    }
    if let Some(app) = action_app {
        let http_no_auth = def.action.application == AppId::Http
            && def
                .action
                .configuration
                .get("authType")
                .and_then(|v| v.as_str())
                .map(|s| s.is_empty() || s == "none")
                .unwrap_or(true);
        if !http_no_auth {
            validate_active_connection(
                "action.connectionId",
                app.auth_kind,
                def.action.application,
                def.action.connection_id.as_deref(),
                owned_connections,
                &mut errors,
            );
        }
    }

    let trigger_def = catalog.get_trigger(def.trigger.application, &def.trigger.event);
    if let Some(td) = trigger_def {
        validate_required_fields(
            "trigger.configuration",
            &td.fields,
            &def.trigger.configuration,
            &mut errors,
        );
    }

    let action_def = catalog.get_action(def.action.application, &def.action.event);
    if let Some(ad) = action_def {
        validate_required_fields(
            "action.configuration",
            &ad.fields,
            &def.action.configuration,
            &mut errors,
        );
    }

    // Validate template variables & filter paths against trigger variables
    if let Some(td) = trigger_def {
        let allow_dynamic_body =
            def.trigger.application == AppId::Webhook && def.trigger.event == "webhook.received";
        let allowed_vars: Vec<&str> = td.variables.iter().map(|v| v.path.as_str()).collect();

        let is_allowed_var = |path: &str| -> bool {
            if allowed_vars.contains(&path) {
                return true;
            }
            allow_dynamic_body && path.starts_with("body.") && path.len() > "body.".len()
        };

        if let Some(ad) = action_def {
            for field in &ad.fields {
                let Some(val) = def.action.configuration.get(&field.key) else {
                    continue;
                };
                let field_err_key = format!("action.configuration.{}", field.key);
                match (field.field_type, val) {
                    (FieldType::Template, ConfigValue::String(s)) => {
                        validate_template_str(&field_err_key, s, &is_allowed_var, &mut errors);
                    }
                    (FieldType::KeyValue, ConfigValue::KeyValueList(pairs)) => {
                        for pair in pairs {
                            validate_template_str(
                                &field_err_key,
                                &pair.value,
                                &is_allowed_var,
                                &mut errors,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }

        for (idx, filter) in def.filters.iter().enumerate() {
            if filter.path.trim().is_empty() {
                errors.insert(
                    format!("filters.{idx}.path"),
                    "Please choose a field to filter on.".to_string(),
                );
            } else if !is_allowed_var(&filter.path) {
                errors.insert(
                    format!("filters.{idx}.path"),
                    format!("Unknown trigger variable '{}'.", filter.path),
                );
            }
            if !matches!(filter.op, FilterOp::IsEmpty | FilterOp::IsNotEmpty)
                && filter
                    .value
                    .as_deref()
                    .map(|v| v.is_empty())
                    .unwrap_or(true)
            {
                errors.insert(
                    format!("filters.{idx}.value"),
                    "Please provide a filter comparison value.".to_string(),
                );
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_step_common(
    prefix: &str,
    app_id: &AppId,
    event: &str,
    connection_id: Option<&str>,
    configuration: &BTreeMap<String, ConfigValue>,
    is_trigger: bool,
    catalog: &Catalog,
    owned_connections: &HashMap<String, ConnectionMeta>,
    errors: &mut BTreeMap<String, String>,
) {
    let Some(app) = catalog.get_app(*app_id) else {
        errors.insert(
            format!("{prefix}.application"),
            format!("Unknown application '{app_id}'."),
        );
        return;
    };

    if !event.is_empty() {
        let valid_event = if is_trigger {
            catalog.get_trigger(*app_id, event).is_some()
        } else {
            catalog.get_action(*app_id, event).is_some()
        };
        if !valid_event {
            errors.insert(
                format!("{prefix}.event"),
                format!("Unknown event '{event}' for {}.", app.name),
            );
        }
    }

    if let Some(cid) = connection_id {
        if app.auth_kind == AuthKind::None {
            errors.insert(
                format!("{prefix}.connectionId"),
                format!("{} does not use a connection.", app.name),
            );
        } else {
            match owned_connections.get(cid) {
                None => {
                    errors.insert(
                        format!("{prefix}.connectionId"),
                        "Selected connection was not found.".to_string(),
                    );
                }
                Some(meta) if meta.application_id != *app_id => {
                    errors.insert(
                        format!("{prefix}.connectionId"),
                        format!("Selected connection does not belong to {}.", app.name),
                    );
                }
                _ => {}
            }
        }
    }

    for (k, v) in configuration {
        let err_key = format!("{prefix}.configuration.{k}");
        match v {
            ConfigValue::String(s) if s.len() > MAX_CONFIG_TEXT_LEN => {
                errors.insert(err_key, "Configuration value exceeds size limit.".to_string());
            }
            ConfigValue::KeyValueList(items) if items.len() > 50 => {
                errors.insert(err_key, "Too many key-value entries.".to_string());
            }
            _ => {}
        }
    }
}

fn validate_active_connection(
    field_key: &str,
    auth_kind: AuthKind,
    expected_app: AppId,
    connection_id: Option<&str>,
    owned_connections: &HashMap<String, ConnectionMeta>,
    errors: &mut BTreeMap<String, String>,
) {
    if auth_kind == AuthKind::None {
        return;
    }
    let Some(cid) = connection_id.filter(|s| !s.trim().is_empty()) else {
        errors.insert(
            field_key.to_string(),
            "Please connect an account for this step.".to_string(),
        );
        return;
    };
    if let Some(meta) = owned_connections.get(cid) {
        if meta.application_id == expected_app && meta.status != ConnectionStatus::Connected {
            errors.insert(
                field_key.to_string(),
                "This connection needs to be reconnected before activating.".to_string(),
            );
        }
    }
}

fn validate_required_fields(
    config_prefix: &str,
    fields: &[FieldDefinition],
    configuration: &BTreeMap<String, ConfigValue>,
    errors: &mut BTreeMap<String, String>,
) {
    for field in fields {
        let err_key = format!("{config_prefix}.{}", field.key);
        let value = configuration.get(&field.key);
        if field.required && value.map(|v| v.is_empty_value()).unwrap_or(true) {
            errors.insert(err_key.clone(), format!("{} is required.", field.label));
            continue;
        }
        if let (Some(options), Some(val)) = (&field.options, value) {
            if !val.is_empty_value() {
                if let Some(selected) = val.as_str() {
                    if !options.iter().any(|o| o.value == selected) {
                        errors.insert(err_key, format!("Invalid option '{selected}'."));
                    }
                }
            }
        }
    }
}

fn validate_template_str<F>(
    field_key: &str,
    tpl: &str,
    is_allowed_var: &F,
    errors: &mut BTreeMap<String, String>,
) where
    F: Fn(&str) -> bool,
{
    match extract_template_vars(tpl) {
        Err(e) => {
            errors.entry(field_key.to_string()).or_insert_with(|| e.to_string());
        }
        Ok(vars) => {
            for var in vars {
                if !is_allowed_var(&var) {
                    errors
                        .entry(field_key.to_string())
                        .or_insert_with(|| format!("Unknown template variable '{{{{{var}}}}}'."));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api_types::{Filter, SelectConfigValue, WorkflowStep};

    fn sample_connections() -> HashMap<String, ConnectionMeta> {
        let mut m = HashMap::new();
        m.insert(
            "con_cu".to_string(),
            ConnectionMeta {
                application_id: AppId::Clickup,
                status: ConnectionStatus::Connected,
            },
        );
        m.insert(
            "con_sl".to_string(),
            ConnectionMeta {
                application_id: AppId::Slack,
                status: ConnectionStatus::Connected,
            },
        );
        m.insert(
            "con_sl_revoked".to_string(),
            ConnectionMeta {
                application_id: AppId::Slack,
                status: ConnectionStatus::NeedsAttention,
            },
        );
        m
    }

    fn valid_active_workflow() -> WorkflowDefinitionV1 {
        let mut trig_cfg = BTreeMap::new();
        trig_cfg.insert(
            "workspaceId".to_string(),
            ConfigValue::Select(SelectConfigValue {
                value: "9012".to_string(),
                label: "Acme".to_string(),
            }),
        );
        trig_cfg.insert("listId".to_string(), ConfigValue::Null);

        let mut act_cfg = BTreeMap::new();
        act_cfg.insert(
            "channel".to_string(),
            ConfigValue::Select(SelectConfigValue {
                value: "C01".to_string(),
                label: "#general".to_string(),
            }),
        );
        act_cfg.insert(
            "message".to_string(),
            ConfigValue::String("New task: {{task.name}} ({{task.url}})".to_string()),
        );

        WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Clickup,
                event: "task.created".to_string(),
                connection_id: Some("con_cu".to_string()),
                configuration: trig_cfg,
            },
            filters: vec![Filter {
                path: "task.status".to_string(),
                op: FilterOp::Equals,
                value: Some("to do".to_string()),
            }],
            action: WorkflowStep {
                application: AppId::Slack,
                event: "message.send".to_string(),
                connection_id: Some("con_sl".to_string()),
                configuration: act_cfg,
            },
        }
    }

    #[test]
    fn valid_workflow_passes_draft_and_active() {
        let catalog = Catalog::mvp();
        let conns = sample_connections();
        let wf = valid_active_workflow();
        assert!(validate_draft(&wf, &catalog, &conns).is_ok());
        assert!(validate_active(&wf, &catalog, &conns).is_ok());
    }

    #[test]
    fn incomplete_draft_passes_draft_but_fails_active_with_per_field_errors() {
        let catalog = Catalog::mvp();
        let conns = sample_connections();
        let wf = WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Clickup,
                event: "".to_string(),
                connection_id: None,
                configuration: BTreeMap::new(),
            },
            filters: vec![],
            action: WorkflowStep {
                application: AppId::Slack,
                event: "message.send".to_string(),
                connection_id: Some("con_sl".to_string()),
                configuration: BTreeMap::new(),
            },
        };

        assert!(validate_draft(&wf, &catalog, &conns).is_ok());
        let errs = validate_active(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("trigger.event"));
        assert!(errs.contains_key("trigger.connectionId"));
        assert!(errs.contains_key("action.configuration.channel"));
        assert!(errs.contains_key("action.configuration.message"));
    }

    #[test]
    fn rejects_wrong_tenant_connection_and_unknown_template_var_and_revoked_conn() {
        let catalog = Catalog::mvp();
        let conns = sample_connections();

        // Cross-tenant / unknown connection fails even in draft
        let mut wf = valid_active_workflow();
        wf.trigger.connection_id = Some("con_other_org".to_string());
        let errs = validate_draft(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("trigger.connectionId"));

        // Mismatched app connection fails in draft
        let mut wf = valid_active_workflow();
        wf.trigger.connection_id = Some("con_sl".to_string());
        let errs = validate_draft(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("trigger.connectionId"));

        // Unknown template variable fails activation
        let mut wf = valid_active_workflow();
        wf.action.configuration.insert(
            "message".to_string(),
            ConfigValue::String("Hello {{task.nonexistent}}".to_string()),
        );
        let errs = validate_active(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("action.configuration.message"));

        // Revoked / needs_attention connection fails activation
        let mut wf = valid_active_workflow();
        wf.action.connection_id = Some("con_sl_revoked".to_string());
        let errs = validate_active(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("action.connectionId"));

        // Invalid filter path fails activation
        let mut wf = valid_active_workflow();
        wf.filters.push(Filter {
            path: "task.bogus".to_string(),
            op: FilterOp::IsNotEmpty,
            value: None,
        });
        let errs = validate_active(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("filters.1.path"));
    }

    #[test]
    fn webhook_trigger_allows_dynamic_body_variables() {
        let catalog = Catalog::mvp();
        let conns = sample_connections();
        let mut trig_cfg = BTreeMap::new();
        trig_cfg.insert(
            "verification".to_string(),
            ConfigValue::String("hmac_sha256".to_string()),
        );
        let mut act_cfg = BTreeMap::new();
        act_cfg.insert(
            "channel".to_string(),
            ConfigValue::String("C01".to_string()),
        );
        act_cfg.insert(
            "message".to_string(),
            ConfigValue::String("Order {{body.customer.email}}".to_string()),
        );

        let wf = WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Webhook,
                event: "webhook.received".to_string(),
                connection_id: None,
                configuration: trig_cfg,
            },
            filters: vec![Filter {
                path: "body.customer.tier".to_string(),
                op: FilterOp::Equals,
                value: Some("pro".to_string()),
            }],
            action: WorkflowStep {
                application: AppId::Slack,
                event: "message.send".to_string(),
                connection_id: Some("con_sl".to_string()),
                configuration: act_cfg,
            },
        };
        assert!(validate_active(&wf, &catalog, &conns).is_ok());
    }

    #[test]
    fn http_action_allows_no_connection_for_none_auth_but_requires_for_bearer() {
        let catalog = Catalog::mvp();
        let conns = sample_connections();
        let mut act_cfg = BTreeMap::new();
        act_cfg.insert("method".to_string(), ConfigValue::String("POST".to_string()));
        act_cfg.insert(
            "url".to_string(),
            ConfigValue::String("https://example.com/hook".to_string()),
        );
        act_cfg.insert("authType".to_string(), ConfigValue::String("none".to_string()));

        let mut trig_cfg = BTreeMap::new();
        trig_cfg.insert(
            "verification".to_string(),
            ConfigValue::String("hmac_sha256".to_string()),
        );

        let mut wf = WorkflowDefinitionV1 {
            version: 1,
            trigger: WorkflowStep {
                application: AppId::Webhook,
                event: "webhook.received".to_string(),
                connection_id: None,
                configuration: trig_cfg,
            },
            filters: vec![],
            action: WorkflowStep {
                application: AppId::Http,
                event: "http.request".to_string(),
                connection_id: None,
                configuration: act_cfg,
            },
        };
        assert!(validate_active(&wf, &catalog, &conns).is_ok());

        wf.action
            .configuration
            .insert("authType".to_string(), ConfigValue::String("bearer".to_string()));
        let errs = validate_active(&wf, &catalog, &conns).unwrap_err();
        assert!(errs.contains_key("action.connectionId"));
    }
}

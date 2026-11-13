use crate::api_types::{AppId, WorkflowDefinitionV1};
use crate::connectors::Catalog;

pub fn summarize_workflow(def: &WorkflowDefinitionV1, catalog: &Catalog) -> String {
    let trigger_app = catalog
        .get_app(def.trigger.application)
        .map(|a| a.name.as_str())
        .unwrap_or("App");
    let trigger_part = catalog
        .get_trigger(def.trigger.application, &def.trigger.event)
        .map(|t| t.label.to_lowercase())
        .unwrap_or_else(|| "a trigger runs".to_string());

    let action_app = catalog
        .get_app(def.action.application)
        .map(|a| a.name.as_str())
        .unwrap_or("App");
    let action_part = match (def.action.application, def.action.event.as_str()) {
        (AppId::Slack, "message.send") => {
            if let Some(ch) = def
                .action
                .configuration
                .get("channel")
                .and_then(|v| v.display_label())
                .filter(|s| !s.is_empty())
            {
                format!("send a message to {ch} in {action_app}")
            } else {
                format!("send a message in {action_app}")
            }
        }
        _ => catalog
            .get_action(def.action.application, &def.action.event)
            .map(|a| format!("{} in {action_app}", a.label.to_lowercase()))
            .unwrap_or_else(|| format!("run an action in {action_app}")),
    };

    let trigger_clause = if def.trigger.event.is_empty() {
        format!("When {trigger_app} triggers")
    } else if trigger_part.starts_with("when ") {
        format!("{}{} in {trigger_app}", trigger_part[..1].to_uppercase(), &trigger_part[1..])
    } else {
        format!("When {trigger_part} in {trigger_app}")
    };

    format!("{trigger_clause}, {action_part}.")
}

use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscapeMode {
    None,
    Slack,
    JsonString,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TemplateError {
    #[error("unclosed template placeholder '{{{{'")]
    UnclosedPlaceholder,
    #[error("empty template variable '{{{{}}}}'")]
    EmptyVariable,
    #[error("invalid variable path '{0}': only dotted identifiers like task.name are supported")]
    InvalidVariablePath(String),
}

pub fn is_valid_var_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 128 {
        return false;
    }
    path.split('.').all(|seg| {
        !seg.is_empty()
            && seg
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// Extracts all `{{dotted.path}}` variable references from a template string.
/// Rejects unclosed braces or unsupported expressions (helpers, loops, logic).
pub fn extract_template_vars(tpl: &str) -> Result<Vec<String>, TemplateError> {
    let mut vars = Vec::new();
    let mut rest = tpl;
    while let Some(start) = rest.find("{{") {
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            return Err(TemplateError::UnclosedPlaceholder);
        };
        let raw_expr = after_open[..end].trim();
        if raw_expr.is_empty() {
            return Err(TemplateError::EmptyVariable);
        }
        if !is_valid_var_path(raw_expr) {
            return Err(TemplateError::InvalidVariablePath(raw_expr.to_string()));
        }
        vars.push(raw_expr.to_string());
        rest = &after_open[end + 2..];
    }
    Ok(vars)
}

/// Looks up a dotted path in `vars`, supporting both flat keys (e.g. `"task.name"`)
/// and nested JSON objects (e.g. `{"task": {"name": "..."}}`).
pub fn lookup_var<'a>(vars: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    if let Some(direct) = vars.get(path) {
        return Some(direct);
    }
    let mut parts = path.split('.');
    let first = parts.next()?;
    let mut current = vars.get(first)?;
    for seg in parts {
        current = current.as_object()?.get(seg)?;
    }
    Some(current)
}

pub fn value_to_plain_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(value_to_plain_string)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Value::Object(_) => serde_json::to_string(v).unwrap_or_default(),
    }
}

pub fn escape_value(raw: &str, mode: EscapeMode) -> String {
    match mode {
        EscapeMode::None => raw.to_string(),
        EscapeMode::Slack => {
            let mut out = String::with_capacity(raw.len());
            for ch in raw.chars() {
                match ch {
                    '&' => out.push_str("&amp;"),
                    '<' => out.push_str("&lt;"),
                    '>' => out.push_str("&gt;"),
                    c => out.push(c),
                }
            }
            out
        }
        EscapeMode::JsonString => {
            let mut out = String::with_capacity(raw.len());
            for ch in raw.chars() {
                match ch {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\x08' => out.push_str("\\b"),
                    '\x0c' => out.push_str("\\f"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        use std::fmt::Write as _;
                        let _ = write!(out, "\\u{:04x}", c as u32);
                    }
                    c => out.push(c),
                }
            }
            out
        }
    }
}

/// Renders `{{dotted.path}}` placeholders using `vars` and applies `escape` to each substituted value.
/// Missing variables render as an empty string `""`.
pub fn render_template(tpl: &str, vars: &Map<String, Value>, escape: EscapeMode) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after_open = &rest[start + 2..];
        let Some(end) = after_open.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let path = after_open[..end].trim();
        if is_valid_var_path(path) {
            let rendered = lookup_var(vars, path)
                .map(value_to_plain_string)
                .unwrap_or_default();
            out.push_str(&escape_value(&rendered, escape));
        }
        rest = &after_open[end + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_flat_and_nested_variables_and_missing_as_empty() {
        let mut vars = Map::new();
        vars.insert("task.name".to_string(), json!("Ship v2"));
        vars.insert(
            "task".to_string(),
            json!({ "url": "https://app.clickup.com/t/123", "priority": 1 }),
        );

        let rendered = render_template(
            "Task: {{task.name}} ({{task.url}}) P{{task.priority}} [{{task.missing}}]",
            &vars,
            EscapeMode::None,
        );
        assert_eq!(
            rendered,
            "Task: Ship v2 (https://app.clickup.com/t/123) P1 []"
        );
    }

    #[test]
    fn renders_slack_escaping() {
        let mut vars = Map::new();
        vars.insert(
            "task.name".to_string(),
            json!("Fix <script> & alert(\"x\") > all"),
        );

        let rendered = render_template("Task: {{task.name}}", &vars, EscapeMode::Slack);
        assert_eq!(
            rendered,
            "Task: Fix &lt;script&gt; &amp; alert(\"x\") &gt; all"
        );
    }

    #[test]
    fn renders_json_string_escaping() {
        let mut vars = Map::new();
        vars.insert(
            "task.name".to_string(),
            json!("Line 1\nLine \"2\" \\ slash\tTab"),
        );

        let rendered = render_template(
            r#"{"text":"{{task.name}}"}"#,
            &vars,
            EscapeMode::JsonString,
        );
        assert_eq!(
            rendered,
            r#"{"text":"Line 1\nLine \"2\" \\ slash\tTab"}"#
        );
        let parsed: Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(parsed["text"], "Line 1\nLine \"2\" \\ slash\tTab");
    }

    #[test]
    fn extract_vars_rejects_invalid_syntax() {
        assert_eq!(
            extract_template_vars("Hello {{task.name}} from {{task.list}}").unwrap(),
            vec!["task.name", "task.list"]
        );
        assert!(matches!(
            extract_template_vars("Hello {{task.name"),
            Err(TemplateError::UnclosedPlaceholder)
        ));
        assert!(matches!(
            extract_template_vars("Hello {{}}"),
            Err(TemplateError::EmptyVariable)
        ));
        assert!(matches!(
            extract_template_vars("Hello {{#if task.name}}"),
            Err(TemplateError::InvalidVariablePath(_))
        ));
    }
}

use serde_json::{Map, Value};

use crate::api_types::{Filter, FilterOp};
use crate::workflow::template::{lookup_var, value_to_plain_string};

/// Evaluates all filters against `vars` using logical AND.
/// An empty filter list evaluates to `true`.
pub fn evaluate_filters(filters: &[Filter], vars: &Map<String, Value>) -> bool {
    filters.iter().all(|f| evaluate_single(f, vars))
}

fn evaluate_single(filter: &Filter, vars: &Map<String, Value>) -> bool {
    let actual = lookup_var(vars, &filter.path)
        .map(value_to_plain_string)
        .unwrap_or_default();
    let expected = filter.value.as_deref().unwrap_or("");

    match filter.op {
        FilterOp::Equals => actual == expected,
        FilterOp::NotEquals => actual != expected,
        FilterOp::Contains => actual.contains(expected),
        FilterOp::NotContains => !actual.contains(expected),
        FilterOp::IsEmpty => actual.trim().is_empty(),
        FilterOp::IsNotEmpty => !actual.trim().is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn evaluates_all_six_filter_ops() {
        let mut vars = Map::new();
        vars.insert("task.status".to_string(), json!("in progress"));
        vars.insert("task.name".to_string(), json!("Deploy production release"));
        vars.insert("task.description".to_string(), json!("   "));

        assert!(evaluate_filters(&[], &vars));

        // equals
        assert!(evaluate_filters(
            &[Filter {
                path: "task.status".into(),
                op: FilterOp::Equals,
                value: Some("in progress".into()),
            }],
            &vars
        ));
        assert!(!evaluate_filters(
            &[Filter {
                path: "task.status".into(),
                op: FilterOp::Equals,
                value: Some("done".into()),
            }],
            &vars
        ));

        // not_equals
        assert!(evaluate_filters(
            &[Filter {
                path: "task.status".into(),
                op: FilterOp::NotEquals,
                value: Some("done".into()),
            }],
            &vars
        ));

        // contains & not_contains
        assert!(evaluate_filters(
            &[Filter {
                path: "task.name".into(),
                op: FilterOp::Contains,
                value: Some("production".into()),
            }],
            &vars
        ));
        assert!(evaluate_filters(
            &[Filter {
                path: "task.name".into(),
                op: FilterOp::NotContains,
                value: Some("staging".into()),
            }],
            &vars
        ));

        // is_empty (whitespace or missing)
        assert!(evaluate_filters(
            &[Filter {
                path: "task.description".into(),
                op: FilterOp::IsEmpty,
                value: None,
            }],
            &vars
        ));
        assert!(evaluate_filters(
            &[Filter {
                path: "task.missing".into(),
                op: FilterOp::IsEmpty,
                value: None,
            }],
            &vars
        ));

        // is_not_empty
        assert!(evaluate_filters(
            &[Filter {
                path: "task.name".into(),
                op: FilterOp::IsNotEmpty,
                value: None,
            }],
            &vars
        ));
        assert!(!evaluate_filters(
            &[Filter {
                path: "task.missing".into(),
                op: FilterOp::IsNotEmpty,
                value: None,
            }],
            &vars
        ));

        // AND semantics across multiple filters
        assert!(!evaluate_filters(
            &[
                Filter {
                    path: "task.status".into(),
                    op: FilterOp::Equals,
                    value: Some("in progress".into()),
                },
                Filter {
                    path: "task.name".into(),
                    op: FilterOp::Contains,
                    value: Some("nonexistent".into()),
                },
            ],
            &vars
        ));
    }
}

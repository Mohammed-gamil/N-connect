use serde_json::{Map, Value};
use worker::Headers;

use crate::api_types::{ActionDefinition, AppId, FieldOption, TriggerDefinition};
use crate::crypto::{constant_time_eq, new_public_id, sha256_hex, verify_hmac_sha256_hex, Secret};

use super::{
    ActionConfig, ActionOutput, AuthSpec, Catalog, Connector, ConnectorError, Cx,
    ExternalSubscription, NewConnection, NormalizedEvent, RenderedInputs, TriggerConfig,
    VerifyError,
};

const MAX_FLATTEN_DEPTH: usize = 8;
const MAX_FLATTENED_KEYS: usize = 256;

pub struct WebhookConnector;

pub fn verify_webhook_headers(
    mode: &str,
    x_hub_sig: Option<&str>,
    x_sig: Option<&str>,
    auth_header: Option<&str>,
    x_webhook_token: Option<&str>,
    raw_body: &[u8],
    secret: &[u8],
) -> Result<(), VerifyError> {
    match mode {
        "none" => Ok(()),
        "hmac_sha256" => {
            let raw_sig = x_hub_sig
                .or(x_sig)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or(VerifyError::MissingSignature)?;
            let hex_sig = raw_sig
                .strip_prefix("sha256=")
                .or_else(|| raw_sig.strip_prefix("SHA256="))
                .unwrap_or(raw_sig)
                .trim();
            if verify_hmac_sha256_hex(secret, raw_body, hex_sig) {
                Ok(())
            } else {
                Err(VerifyError::InvalidSignature)
            }
        }
        "shared_token" => {
            let bearer = auth_header.and_then(|h| {
                let trimmed = h.trim();
                let prefix = trimmed.get(..7)?;
                if prefix.eq_ignore_ascii_case("bearer ") {
                    let tok = trimmed[7..].trim();
                    if !tok.is_empty() {
                        return Some(tok);
                    }
                }
                None
            });
            let token = bearer
                .or_else(|| x_webhook_token.map(str::trim).filter(|s| !s.is_empty()))
                .ok_or(VerifyError::MissingSignature)?;
            if constant_time_eq(token.as_bytes(), secret) {
                Ok(())
            } else {
                Err(VerifyError::InvalidSignature)
            }
        }
        _ => Err(VerifyError::MalformedRequest),
    }
}

pub fn verify_with_mode(
    mode: &str,
    headers: &Headers,
    raw_body: &[u8],
    secret: &[u8],
) -> Result<(), VerifyError> {
    let x_hub_sig = headers.get("X-Hub-Signature-256").ok().flatten();
    let x_sig = headers.get("X-Signature").ok().flatten();
    let auth_header = headers.get("Authorization").ok().flatten();
    let x_webhook_token = headers.get("X-Webhook-Token").ok().flatten();
    verify_webhook_headers(
        mode,
        x_hub_sig.as_deref(),
        x_sig.as_deref(),
        auth_header.as_deref(),
        x_webhook_token.as_deref(),
        raw_body,
        secret,
    )
}

pub fn webhook_dedup_key(raw: &Value, raw_body: &[u8]) -> String {
    for field in ["id", "event_id", "eventId", "delivery_id"] {
        if let Some(s) = raw[field].as_str().map(str::trim).filter(|s| !s.is_empty()) {
            return format!("body:{s}");
        }
        if let Some(n) = raw[field].as_i64() {
            return format!("body:{n}");
        }
    }
    sha256_hex(raw_body)
}

fn flatten_json(
    prefix: &str,
    val: &Value,
    depth: usize,
    out: &mut Map<String, Value>,
) {
    if out.len() >= MAX_FLATTENED_KEYS || depth > MAX_FLATTEN_DEPTH {
        return;
    }

    match val {
        Value::Object(map) => {
            if !prefix.is_empty() {
                out.insert(
                    prefix.to_string(),
                    Value::String(serde_json::to_string(val).unwrap_or_default()),
                );
            }
            for (k, v) in map {
                if out.len() >= MAX_FLATTENED_KEYS {
                    break;
                }
                let next_key = if prefix.is_empty() {
                    format!("body.{k}")
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_json(&next_key, v, depth + 1, out);
            }
        }
        Value::Array(_) => {
            if !prefix.is_empty() {
                out.insert(
                    prefix.to_string(),
                    Value::String(serde_json::to_string(val).unwrap_or_default()),
                );
            }
        }
        _ => {
            if !prefix.is_empty() {
                out.insert(prefix.to_string(), val.clone());
            }
        }
    }
}

pub fn normalize_webhook_payload(raw: &Value) -> NormalizedEvent {
    let mut vars = Map::new();
    flatten_json("", raw, 0, &mut vars);

    let event_name = raw["event"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let trigger_summary = match event_name {
        Some(ev) => format!("Webhook received ({ev})"),
        None => "Webhook received".to_string(),
    };

    NormalizedEvent {
        trigger_summary,
        variables: vars,
    }
}

#[async_trait::async_trait(?Send)]
impl Connector for WebhookConnector {
    fn id(&self) -> AppId {
        AppId::Webhook
    }

    fn name(&self) -> &'static str {
        "Custom Webhook"
    }

    fn auth(&self) -> AuthSpec {
        AuthSpec::None
    }

    fn triggers(&self) -> Vec<TriggerDefinition> {
        Catalog::mvp()
            .get_app(AppId::Webhook)
            .map(|a| a.triggers.clone())
            .unwrap_or_default()
    }

    fn actions(&self) -> Vec<ActionDefinition> {
        vec![]
    }

    async fn complete_oauth(
        &self,
        _cx: &Cx<'_>,
        _code: &str,
    ) -> Result<NewConnection, ConnectorError> {
        Err(ConnectorError::permanent(
            "Custom Webhook does not use OAuth.",
            "webhook complete_oauth called",
        ))
    }

    async fn field_options(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _field: &str,
        _parent: Option<&str>,
    ) -> Result<Vec<FieldOption>, ConnectorError> {
        Ok(vec![])
    }

    async fn subscribe(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        trigger: &TriggerConfig,
        _callback_url: &str,
    ) -> Result<ExternalSubscription, ConnectorError> {
        let verification = trigger
            .configuration
            .get("verification")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| matches!(*s, "hmac_sha256" | "shared_token" | "none"))
            .unwrap_or("hmac_sha256")
            .to_string();

        let signing_secret = if verification == "none" {
            None
        } else {
            let tok = new_public_id().map_err(|e| {
                ConnectorError::permanent("Failed to generate webhook secret.", e.to_string())
            })?;
            Some(Secret::from_string(format!("whsec_{tok}")))
        };

        Ok(ExternalSubscription {
            external_webhook_id: None,
            signing_secret,
            verification,
        })
    }

    async fn unsubscribe(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _sub: &ExternalSubscription,
    ) -> Result<(), ConnectorError> {
        Ok(())
    }

    fn verify(
        &self,
        headers: &Headers,
        raw_body: &[u8],
        secret: &[u8],
    ) -> Result<(), VerifyError> {
        if secret.is_empty() {
            return Ok(());
        }
        let x_hub_sig = headers.get("X-Hub-Signature-256").ok().flatten();
        let x_sig = headers.get("X-Signature").ok().flatten();
        if x_hub_sig.is_some() || x_sig.is_some() {
            return verify_webhook_headers(
                "hmac_sha256",
                x_hub_sig.as_deref(),
                x_sig.as_deref(),
                None,
                None,
                raw_body,
                secret,
            );
        }
        let auth_header = headers.get("Authorization").ok().flatten();
        let x_webhook_token = headers.get("X-Webhook-Token").ok().flatten();
        if auth_header.is_some() || x_webhook_token.is_some() {
            return verify_webhook_headers(
                "shared_token",
                None,
                None,
                auth_header.as_deref(),
                x_webhook_token.as_deref(),
                raw_body,
                secret,
            );
        }
        Err(VerifyError::MissingSignature)
    }

    fn dedup_key(&self, raw: &Value, raw_body: &[u8]) -> String {
        webhook_dedup_key(raw, raw_body)
    }

    async fn normalize(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _trigger: &TriggerConfig,
        raw: &Value,
    ) -> Result<Option<NormalizedEvent>, ConnectorError> {
        Ok(Some(normalize_webhook_payload(raw)))
    }

    async fn execute(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _action: &ActionConfig,
        _inputs: &RenderedInputs,
    ) -> Result<ActionOutput, ConnectorError> {
        Err(ConnectorError::permanent(
            "Custom Webhook does not support outbound actions.",
            "webhook execute called",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::hmac_sha256_hex;
    use serde_json::json;

    #[test]
    fn verifies_hmac_shared_token_and_none_modes() {
        let secret = b"whsec_super_secret";
        let body = br#"{"event":"order.paid","id":"evt_1"}"#;
        let sig_hex = hmac_sha256_hex(secret, body);
        let prefixed = format!("sha256={sig_hex}");

        // hmac_sha256 with X-Hub-Signature-256 and sha256= prefix
        assert!(verify_webhook_headers(
            "hmac_sha256",
            Some(&prefixed),
            None,
            None,
            None,
            body,
            secret
        )
        .is_ok());

        // hmac_sha256 with raw X-Signature
        assert!(verify_webhook_headers(
            "hmac_sha256",
            None,
            Some(&sig_hex),
            None,
            None,
            body,
            secret
        )
        .is_ok());

        assert!(matches!(
            verify_webhook_headers("hmac_sha256", None, None, None, None, body, secret),
            Err(VerifyError::MissingSignature)
        ));
        assert!(matches!(
            verify_webhook_headers(
                "hmac_sha256",
                Some("sha256=deadbeef"),
                None,
                None,
                None,
                body,
                secret
            ),
            Err(VerifyError::InvalidSignature)
        ));

        // shared_token via Bearer and X-Webhook-Token
        assert!(verify_webhook_headers(
            "shared_token",
            None,
            None,
            Some("Bearer whsec_super_secret"),
            None,
            body,
            secret
        )
        .is_ok());
        assert!(verify_webhook_headers(
            "shared_token",
            None,
            None,
            None,
            Some("whsec_super_secret"),
            body,
            secret
        )
        .is_ok());
        assert!(matches!(
            verify_webhook_headers(
                "shared_token",
                None,
                None,
                Some("Bearer wrong"),
                None,
                body,
                secret
            ),
            Err(VerifyError::InvalidSignature)
        ));

        // none
        assert!(verify_webhook_headers("none", None, None, None, None, body, b"").is_ok());
    }

    #[test]
    fn flattens_nested_json_into_body_variables() {
        let payload = json!({
            "event": "order.paid",
            "id": "evt_123",
            "data": {
                "amount": 42,
                "customer": {
                    "email": "ada@example.com"
                }
            }
        });
        let norm = normalize_webhook_payload(&payload);
        assert_eq!(norm.trigger_summary, "Webhook received (order.paid)");
        assert_eq!(norm.variables["body.event"], "order.paid");
        assert_eq!(norm.variables["body.id"], "evt_123");
        assert_eq!(norm.variables["body.data.amount"], 42);
        assert_eq!(
            norm.variables["body.data.customer.email"],
            "ada@example.com"
        );
        assert!(norm.variables["body.data"].is_string());
    }

    #[test]
    fn webhook_dedup_uses_id_or_body_sha256() {
        let with_id = json!({ "id": "evt_77", "event": "ping" });
        assert_eq!(webhook_dedup_key(&with_id, b"{}"), "body:evt_77");

        let without_id = json!({ "event": "ping" });
        let body = br#"{"event":"ping"}"#;
        assert_eq!(webhook_dedup_key(&without_id, body), sha256_hex(body));
    }
}

use serde::Serialize;
use serde_json::{json, Value};
use worker::{Request, Response, RouteContext};

use crate::connectors::clickup::{verify_clickup_signature, ClickUpConnector};
use crate::connectors::webhook::{verify_webhook_headers, WebhookConnector};
use crate::connectors::{Connector, VerifyError};
use crate::crypto::{
    decrypt_secret, load_master_key, make_credential_aad, new_id, Secret, PREFIX_EVENT,
};
use crate::db::{credentials, d1, events, webhooks};
use crate::engine::processor::QueuePayload;
use crate::http::{
    json_response, log_structured, now_ms, read_body_limited, AppError, MAX_HOOK_BODY_BYTES,
};

pub const MAX_STORED_PAYLOAD_BYTES: usize = 65_536;

#[derive(Debug, Serialize)]
struct WebhookAck {
    accepted: bool,
}

/// Pure signature verification helper for native unit tests and webhook handling.
#[allow(clippy::too_many_arguments)]
pub fn verify_webhook_request(
    provider: &str,
    verification: &str,
    x_hub_sig: Option<&str>,
    x_sig: Option<&str>,
    auth_header: Option<&str>,
    x_webhook_token: Option<&str>,
    raw_body: &[u8],
    secret: Option<&[u8]>,
) -> Result<(), VerifyError> {
    match provider {
        "clickup" => {
            let sec = secret.ok_or(VerifyError::InvalidSignature)?;
            verify_clickup_signature(x_sig, raw_body, sec)
        }
        "custom" => {
            if verification == "none" {
                return verify_webhook_headers(
                    "none",
                    x_hub_sig,
                    x_sig,
                    auth_header,
                    x_webhook_token,
                    raw_body,
                    b"",
                );
            }
            let sec = secret.ok_or(VerifyError::InvalidSignature)?;
            verify_webhook_headers(
                verification,
                x_hub_sig,
                x_sig,
                auth_header,
                x_webhook_token,
                raw_body,
                sec,
            )
        }
        _ => Err(VerifyError::MalformedRequest),
    }
}

/// Ensures stored webhook payloads never exceed 64 KB (`65_536` bytes) while remaining valid JSON.
pub fn truncate_payload_for_storage(raw_body: &[u8]) -> String {
    if raw_body.len() <= MAX_STORED_PAYLOAD_BYTES {
        if let Ok(s) = std::str::from_utf8(raw_body) {
            return s.to_string();
        }
    }

    let raw_text = String::from_utf8_lossy(raw_body);
    let mut max_preview_bytes = 60_000usize.min(raw_text.len());
    loop {
        let mut end = max_preview_bytes;
        while end > 0 && !raw_text.is_char_boundary(end) {
            end -= 1;
        }
        let wrapper = json!({
            "_truncated": true,
            "preview": &raw_text[..end],
        });
        let serialized = wrapper.to_string();
        if serialized.len() <= MAX_STORED_PAYLOAD_BYTES || end == 0 {
            return serialized;
        }
        max_preview_bytes = end / 2;
    }
}

pub fn validate_hook_body_size(len: usize) -> Result<(), AppError> {
    if len > MAX_HOOK_BODY_BYTES {
        return Err(AppError::PayloadTooLarge(format!(
            "Request body exceeds {MAX_HOOK_BODY_BYTES} byte limit."
        )));
    }
    Ok(())
}

pub async fn handle_webhook(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();

    let Some(public_id) = ctx
        .param("publicId")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return Ok(json_response(
            200,
            &WebhookAck { accepted: false },
            request_id,
            None,
        )?);
    };

    let db = d1(&ctx.env)?;
    let Some(sub) = webhooks::find_by_public_id(&db, public_id).await? else {
        return Ok(json_response(
            200,
            &WebhookAck { accepted: false },
            request_id,
            None,
        )?);
    };

    if sub.status == "deleted" {
        return Ok(json_response(
            200,
            &WebhookAck { accepted: false },
            request_id,
            None,
        )?);
    }

    let raw_body = read_body_limited(&mut req, MAX_HOOK_BODY_BYTES).await?;
    validate_hook_body_size(raw_body.len())?;

    // Load & decrypt secret (if configured on this subscription) BEFORE parsing payload.
    let decrypted_secret: Option<Secret> = if let Some(ref cred_id) = sub.secret_credential_id {
        let cred = credentials::get_credential(&db, &sub.org_id, cred_id)
            .await?
            .ok_or_else(|| AppError::Internal("Webhook secret credential missing.".to_string()))?;
        let master_key = load_master_key(&ctx.env, cred.key_version)?;
        let aad = make_credential_aad(&sub.org_id, &cred.id, "webhook_secret");
        Some(decrypt_secret(
            &master_key,
            &cred.ciphertext,
            &cred.nonce,
            &aad,
        )?)
    } else {
        None
    };

    let headers = req.headers();
    let x_hub_sig = headers.get("X-Hub-Signature-256").ok().flatten();
    let x_sig = headers.get("X-Signature").ok().flatten();
    let auth_header = headers.get("Authorization").ok().flatten();
    let x_webhook_token = headers.get("X-Webhook-Token").ok().flatten();

    if let Err(verify_err) = verify_webhook_request(
        &sub.provider,
        &sub.verification,
        x_hub_sig.as_deref(),
        x_sig.as_deref(),
        auth_header.as_deref(),
        x_webhook_token.as_deref(),
        &raw_body,
        decrypted_secret.as_ref().map(|s| s.as_bytes()),
    ) {
        log_structured(
            "warn",
            "webhook_signature_rejected",
            request_id,
            Some(&sub.org_id),
            Some(400),
            Some(&format!("provider={} err={verify_err}", sub.provider)),
        );
        return Err(AppError::BadRequest(
            "Webhook signature verification failed.".to_string(),
        ));
    }

    let parsed: Value = serde_json::from_slice(&raw_body)
        .map_err(|_| AppError::BadRequest("Malformed JSON webhook payload.".to_string()))?;

    let stored_payload = truncate_payload_for_storage(&raw_body);
    let dedup_key = match sub.provider.as_str() {
        "clickup" => ClickUpConnector.dedup_key(&parsed, &raw_body),
        "custom" => WebhookConnector.dedup_key(&parsed, &raw_body),
        other => {
            return Err(AppError::BadRequest(format!(
                "Unsupported webhook provider '{other}'."
            )));
        }
    };

    let event_id = new_id(PREFIX_EVENT)?;
    let is_new = events::insert_event_dedup(
        &db,
        &sub.org_id,
        &event_id,
        &sub.id,
        &dedup_key,
        &stored_payload,
        now,
    )
    .await?;

    webhooks::touch_last_received(&db, &sub.org_id, &sub.id, now).await?;

    if is_new && sub.status == "active" {
        let queue = ctx.env.queue("EXECUTIONS")?;
        let payload = QueuePayload {
            event_id,
            automation_id: sub.automation_id,
            org_id: sub.org_id,
            manual_retry: false,
        };
        queue.send(payload).await?;
    }

    Ok(json_response(
        200,
        &WebhookAck { accepted: true },
        request_id,
        None,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::hmac_sha256_hex;

    #[test]
    fn verifies_clickup_and_custom_webhook_signatures() {
        let secret = b"cu_secret_abc";
        let body = br#"{"event":"taskCreated","task_id":"t1"}"#;
        let sig = hmac_sha256_hex(secret, body);

        assert!(verify_webhook_request(
            "clickup",
            "clickup_hmac",
            None,
            Some(&sig),
            None,
            None,
            body,
            Some(secret)
        )
        .is_ok());

        // Missing or wrong signature rejected
        assert!(verify_webhook_request(
            "clickup",
            "clickup_hmac",
            None,
            None,
            None,
            None,
            body,
            Some(secret)
        )
        .is_err());
        assert!(verify_webhook_request(
            "clickup",
            "clickup_hmac",
            None,
            Some(&sig),
            None,
            None,
            b"tampered",
            Some(secret)
        )
        .is_err());

        // Custom hmac_sha256 with sha256= prefix
        let prefixed = format!("sha256={sig}");
        assert!(verify_webhook_request(
            "custom",
            "hmac_sha256",
            Some(&prefixed),
            None,
            None,
            None,
            body,
            Some(secret)
        )
        .is_ok());

        // Custom shared_token
        assert!(verify_webhook_request(
            "custom",
            "shared_token",
            None,
            None,
            Some("Bearer cu_secret_abc"),
            None,
            body,
            Some(secret)
        )
        .is_ok());

        // Custom none
        assert!(verify_webhook_request(
            "custom",
            "none",
            None,
            None,
            None,
            None,
            body,
            None
        )
        .is_ok());
    }

    #[test]
    fn enforces_body_limit_and_truncates_stored_payload_cleanly() {
        assert!(validate_hook_body_size(MAX_HOOK_BODY_BYTES).is_ok());
        assert!(matches!(
            validate_hook_body_size(MAX_HOOK_BODY_BYTES + 1),
            Err(AppError::PayloadTooLarge(_))
        ));

        let small = br#"{"hello":"world"}"#;
        assert_eq!(truncate_payload_for_storage(small), r#"{"hello":"world"}"#);

        // Oversized payload with quotes and multi-byte UTF-8 characters
        let repeated = "🦀\"\\".repeat(20_000);
        let big = format!(r#"{{"data":"{repeated}"}}"#);
        assert!(big.len() > MAX_STORED_PAYLOAD_BYTES);

        let stored = truncate_payload_for_storage(big.as_bytes());
        assert!(stored.len() <= MAX_STORED_PAYLOAD_BYTES);
        let parsed: Value = serde_json::from_str(&stored).expect("truncated payload must be valid JSON");
        assert_eq!(parsed["_truncated"], Value::Bool(true));
        assert!(parsed["preview"].is_string());
    }
}

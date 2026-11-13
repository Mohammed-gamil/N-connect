use worker::{Env, Request};

use crate::crypto::{random_token_b64url, sha256_hex, CryptoError};

pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const SESSION_TTL_SECS: i64 = 30 * 24 * 60 * 60;
/// Refresh session expiry when remaining lifetime is below 25 days (sliding 30-day window).
pub const SESSION_REFRESH_THRESHOLD_MS: i64 = 25 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct CookieConfig {
    pub name: &'static str,
    pub secure: bool,
}

impl CookieConfig {
    /// Uses `__Host-session` with `Secure` in production/HTTPS, and `session` without `Secure`
    /// only when `ENVIRONMENT == "development"` and `APP_ORIGIN` starts with `http://`.
    pub fn from_env(env: &Env) -> Self {
        let environment = env
            .var("ENVIRONMENT")
            .map(|v| v.to_string())
            .unwrap_or_default();
        let app_origin = env
            .var("APP_ORIGIN")
            .map(|v| v.to_string())
            .unwrap_or_default();

        if environment == "development" && app_origin.starts_with("http://") {
            Self {
                name: "session",
                secure: false,
            }
        } else {
            Self {
                name: "__Host-session",
                secure: true,
            }
        }
    }

    pub fn format_set_cookie(&self, token: &str, max_age_secs: i64) -> String {
        if self.secure {
            format!(
                "{}={}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={}",
                self.name, token, max_age_secs
            )
        } else {
            format!(
                "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
                self.name, token, max_age_secs
            )
        }
    }

    pub fn format_clear_cookie(&self) -> String {
        if self.secure {
            format!(
                "{}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
                self.name
            )
        } else {
            format!(
                "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
                self.name
            )
        }
    }
}

pub fn generate_session_token() -> Result<(String, String), CryptoError> {
    let raw_token = random_token_b64url(32)?; // 256 bits
    let token_hash = sha256_hex(raw_token.as_bytes());
    Ok((raw_token, token_hash))
}

pub fn extract_cookie_token(req: &Request, cookie_name: &str) -> Option<String> {
    let header = req.headers().get("Cookie").ok().flatten()?;
    parse_cookie_value(&header, cookie_name)
}

pub fn parse_cookie_value(cookie_header: &str, cookie_name: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((name, value)) = trimmed.split_once('=') {
            if name.trim() == cookie_name {
                let v = value.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cookie_header_extracts_target_cookie() {
        let h = "foo=bar; __Host-session=abc123_xyz; other=1";
        assert_eq!(
            parse_cookie_value(h, "__Host-session").as_deref(),
            Some("abc123_xyz")
        );
        assert_eq!(parse_cookie_value(h, "session"), None);
        assert_eq!(parse_cookie_value("session=tok1", "session").as_deref(), Some("tok1"));
    }

    #[test]
    fn cookie_formatting_matches_security_rules() {
        let prod = CookieConfig {
            name: "__Host-session",
            secure: true,
        };
        assert_eq!(
            prod.format_set_cookie("tok", 2592000),
            "__Host-session=tok; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
        );
        assert_eq!(
            prod.format_clear_cookie(),
            "__Host-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        );

        let dev = CookieConfig {
            name: "session",
            secure: false,
        };
        assert_eq!(
            dev.format_set_cookie("tok", 2592000),
            "session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
        );
    }
}

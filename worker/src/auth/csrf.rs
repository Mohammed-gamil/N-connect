use worker::{Env, Method, Request};

/// Enforce CSRF rules for `/api/*`:
/// Every non-GET `/api/*` request must include `X-Requested-With: hub`,
/// and if an `Origin` header is present it must match `APP_ORIGIN`.
pub fn verify_csrf(req: &Request, env: &Env) -> Result<(), &'static str> {
    if req.method() == Method::Get || req.method() == Method::Head {
        return Ok(());
    }

    let x_req = req
        .headers()
        .get("X-Requested-With")
        .ok()
        .flatten()
        .unwrap_or_default();
    if x_req != "hub" {
        return Err("Missing or invalid X-Requested-With header");
    }

    if let Ok(Some(origin)) = req.headers().get("Origin") {
        let app_origin = env
            .var("APP_ORIGIN")
            .map(|v| v.to_string())
            .unwrap_or_default();
        let is_dev = env
            .var("ENVIRONMENT")
            .map(|v| v.to_string().eq_ignore_ascii_case("development"))
            .unwrap_or(false);
        if !origins_match_for_env(&origin, &app_origin, is_dev) {
            return Err("Origin header does not match APP_ORIGIN");
        }
    }

    Ok(())
}

pub fn origins_match(header_origin: &str, configured_origin: &str) -> bool {
    let a = header_origin.trim().trim_end_matches('/');
    let b = configured_origin.trim().trim_end_matches('/');
    !a.is_empty() && !b.is_empty() && a.eq_ignore_ascii_case(b)
}

pub fn origins_match_for_env(header_origin: &str, configured_origin: &str, is_dev: bool) -> bool {
    if origins_match(header_origin, configured_origin) {
        return true;
    }
    if !is_dev {
        return false;
    }
    let (Ok(a), Ok(b)) = (
        url::Url::parse(header_origin.trim()),
        url::Url::parse(configured_origin.trim()),
    ) else {
        return false;
    };
    let is_loopback = |u: &url::Url| {
        matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    };
    a.scheme() == b.scheme()
        && a.port_or_known_default() == b.port_or_known_default()
        && is_loopback(&a)
        && is_loopback(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_matching_normalizes_trailing_slash() {
        assert!(origins_match("https://hub.example.com", "https://hub.example.com/"));
        assert!(origins_match("http://localhost:8787", "http://localhost:8787"));
        assert!(!origins_match("https://evil.example.com", "https://hub.example.com"));
        assert!(!origins_match("", "https://hub.example.com"));
    }

    #[test]
    fn dev_mode_allows_loopback_aliases_on_same_port_only() {
        assert!(origins_match_for_env("http://127.0.0.1:8787", "http://localhost:8787", true));
        assert!(origins_match_for_env("http://[::1]:8787", "http://localhost:8787", true));
        assert!(!origins_match_for_env("http://127.0.0.1:9999", "http://localhost:8787", true));
        assert!(!origins_match_for_env("http://evil.example.com:8787", "http://localhost:8787", true));
        assert!(!origins_match_for_env("http://127.0.0.1:8787", "http://localhost:8787", false));
    }
}

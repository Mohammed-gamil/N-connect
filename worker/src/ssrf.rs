use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::Deserialize;
use thiserror::Error;
use url::{Host, Url};

pub const MAX_RESPONSE_BYTES: usize = 1_048_576; // 1 MB
pub const FETCH_TIMEOUT_MS: u64 = 10_000; // 10 seconds

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SsrfError {
    #[error("Please enter a valid http or https URL.")]
    InvalidUrl,
    #[error("Only http and https URLs are allowed.")]
    UnsupportedScheme,
    #[error("URLs cannot include embedded usernames or passwords.")]
    CredentialsInUrl,
    #[error("Only standard HTTP (80) and HTTPS (443) ports are allowed.")]
    DisallowedPort,
    #[error("That address points to a private or internal host, which isn't allowed.")]
    BlockedHost,
    #[error("That address points to a private network, which isn't allowed.")]
    BlockedIp,
    #[error("Could not resolve the destination hostname.")]
    DnsResolutionFailed,
    #[error("The request timed out after 10 seconds.")]
    Timeout,
    #[error("The outbound HTTP request failed: {0}")]
    FetchFailed(String),
}

#[derive(Debug, Clone)]
pub struct SafeFetchResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
struct DohResponse {
    #[serde(rename = "Status")]
    status: Option<u32>,
    #[serde(rename = "Answer")]
    answer: Option<Vec<DohAnswer>>,
}

#[derive(Debug, Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    record_type: Option<u16>,
    data: Option<String>,
}

/// Checks whether an IPv4 address belongs to any loopback, private, link-local,
/// metadata, CGNAT, documentation, multicast, or reserved range.
pub fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    // 0.0.0.0/8 ("this network")
    if o[0] == 0 {
        return true;
    }
    // 10.0.0.0/8 (RFC 1918)
    if o[0] == 10 {
        return true;
    }
    // 100.64.0.0/10 (CGNAT, RFC 6598)
    if o[0] == 100 && (o[1] & 0b1100_0000) == 64 {
        return true;
    }
    // 127.0.0.0/8 (loopback)
    if o[0] == 127 {
        return true;
    }
    // 169.254.0.0/16 (link-local & cloud metadata 169.254.169.254)
    if o[0] == 169 && o[1] == 254 {
        return true;
    }
    // 172.16.0.0/12 (RFC 1918)
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return true;
    }
    // 192.0.0.0/24 (IETF protocol assignments)
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return true;
    }
    // 192.0.2.0/24 (TEST-NET-1)
    if o[0] == 192 && o[1] == 0 && o[2] == 2 {
        return true;
    }
    // 192.168.0.0/16 (RFC 1918)
    if o[0] == 192 && o[1] == 168 {
        return true;
    }
    // 198.18.0.0/15 (benchmarking)
    if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        return true;
    }
    // 198.51.100.0/24 (TEST-NET-2)
    if o[0] == 198 && o[1] == 51 && o[2] == 100 {
        return true;
    }
    // 203.0.113.0/24 (TEST-NET-3)
    if o[0] == 203 && o[1] == 0 && o[2] == 113 {
        return true;
    }
    // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved + broadcast)
    if o[0] >= 224 {
        return true;
    }
    false
}

/// Checks whether an IPv6 address belongs to any unspecified, loopback, ULA,
/// link-local, multicast, NAT64, discard, documentation, or blocked IPv4-mapped range.
pub fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return true;
    }
    let segs = ip.segments();

    // fc00::/7 (Unique Local Addresses)
    if (segs[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // fe80::/10 (Link-Local)
    if (segs[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // ff00::/8 (Multicast)
    if (segs[0] & 0xff00) == 0xff00 {
        return true;
    }
    // ::ffff:0:0/96 (IPv4-mapped IPv6 — recursively check embedded IPv4)
    if segs[0..5] == [0, 0, 0, 0, 0] && segs[5] == 0xffff {
        let embedded = Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            segs[6] as u8,
            (segs[7] >> 8) as u8,
            segs[7] as u8,
        );
        return is_blocked_ipv4(embedded);
    }
    // ::/96 (IPv4-compatible deprecated)
    if segs[0..6] == [0, 0, 0, 0, 0, 0] {
        let embedded = Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            segs[6] as u8,
            (segs[7] >> 8) as u8,
            segs[7] as u8,
        );
        return is_blocked_ipv4(embedded);
    }
    // 64:ff9b::/96 (NAT64)
    if segs[0] == 0x0064 && segs[1] == 0xff9b && segs[2..6] == [0, 0, 0, 0] {
        return true;
    }
    // 100::/64 (Discard-Only)
    if segs[0] == 0x0100 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0 {
        return true;
    }
    // 2001:db8::/32 (Documentation)
    if segs[0] == 0x2001 && segs[1] == 0x0db8 {
        return true;
    }
    false
}

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn is_blocked_hostname(host: &str) -> bool {
    let h = normalize_host(host);
    if h.is_empty() {
        return true;
    }
    h == "localhost"
        || h.ends_with(".localhost")
        || h == "local"
        || h.ends_with(".local")
        || h == "internal"
        || h.ends_with(".internal")
        || h == "localdomain"
        || h.ends_with(".localdomain")
        || h == "metadata.google.internal"
}

/// Validates URL syntax, scheme, port, credentials, hostname blocklist, and IP literal blocklists.
pub fn validate_url_syntax_and_host(raw_url: &str, app_origin: &str) -> Result<Url, SsrfError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(SsrfError::InvalidUrl);
    }

    let parsed = Url::parse(trimmed).map_err(|_| SsrfError::InvalidUrl)?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(SsrfError::UnsupportedScheme),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(SsrfError::CredentialsInUrl);
    }

    match parsed.port() {
        None | Some(80) | Some(443) => {}
        Some(_) => return Err(SsrfError::DisallowedPort),
    }

    let host = parsed.host().ok_or(SsrfError::InvalidUrl)?;
    match host {
        Host::Ipv4(v4) => {
            if is_blocked_ipv4(v4) {
                return Err(SsrfError::BlockedIp);
            }
        }
        Host::Ipv6(v6) => {
            if is_blocked_ipv6(v6) {
                return Err(SsrfError::BlockedIp);
            }
        }
        Host::Domain(domain) => {
            let clean = normalize_host(domain);
            if is_blocked_hostname(&clean) {
                return Err(SsrfError::BlockedHost);
            }
            if let Ok(v4) = clean.parse::<Ipv4Addr>() {
                if is_blocked_ipv4(v4) {
                    return Err(SsrfError::BlockedIp);
                }
            }
            if let Ok(v6) = clean.trim_matches(['[', ']']).parse::<Ipv6Addr>() {
                if is_blocked_ipv6(v6) {
                    return Err(SsrfError::BlockedIp);
                }
            }

            if !app_origin.trim().is_empty() {
                if let Ok(origin_url) = Url::parse(app_origin.trim()) {
                    if let Some(origin_host) = origin_url.host_str() {
                        if clean == normalize_host(origin_host) {
                            return Err(SsrfError::BlockedHost);
                        }
                    }
                }
            }
        }
    }

    Ok(parsed)
}

/// Parses DNS-over-HTTPS JSON `Answer` entries and returns resolved IP addresses.
/// Fails closed if `Status` is missing or indicates a resolver error (anything other than 0=NOERROR or 3=NXDOMAIN).
pub fn parse_doh_ips(json_bytes: &[u8]) -> Result<Vec<IpAddr>, SsrfError> {
    let doh: DohResponse =
        serde_json::from_slice(json_bytes).map_err(|_| SsrfError::DnsResolutionFailed)?;
    match doh.status {
        Some(0) | Some(3) => {}
        _ => return Err(SsrfError::DnsResolutionFailed),
    }
    let mut ips = Vec::new();
    if let Some(answers) = doh.answer {
        for ans in answers {
            let rtype = ans.record_type.unwrap_or(0);
            if rtype != 1 && rtype != 28 {
                continue;
            }
            if let Some(data) = ans.data {
                if let Ok(ip) = data.trim().parse::<IpAddr>() {
                    ips.push(ip);
                }
            }
        }
    }
    Ok(ips)
}

/// Validates a set of resolved IP addresses; rejects if empty or if ANY IP is blocked.
pub fn validate_resolved_ips(ips: &[IpAddr]) -> Result<(), SsrfError> {
    if ips.is_empty() {
        return Err(SsrfError::DnsResolutionFailed);
    }
    for &ip in ips {
        if is_blocked_ip(ip) {
            return Err(SsrfError::BlockedIp);
        }
    }
    Ok(())
}

/// Resolves DNS via Cloudflare DoH on wasm32 (or system resolver natively) and rejects
/// if no A/AAAA records exist or if any resolved IP is in a blocked range.
pub async fn resolve_and_validate_dns(url: &Url) -> Result<(), SsrfError> {
    match url.host() {
        Some(Host::Ipv4(v4)) => {
            if is_blocked_ipv4(v4) {
                return Err(SsrfError::BlockedIp);
            }
            Ok(())
        }
        Some(Host::Ipv6(v6)) => {
            if is_blocked_ipv6(v6) {
                return Err(SsrfError::BlockedIp);
            }
            Ok(())
        }
        Some(Host::Domain(domain)) => {
            let clean = normalize_host(domain);
            if is_blocked_hostname(&clean) {
                return Err(SsrfError::BlockedHost);
            }
            resolve_domain_and_validate(&clean).await
        }
        None => Err(SsrfError::InvalidUrl),
    }
}

#[cfg(target_arch = "wasm32")]
async fn resolve_domain_and_validate(domain: &str) -> Result<(), SsrfError> {
    let mut all_ips = Vec::new();
    for qtype in ["A", "AAAA"] {
        let mut doh_url = Url::parse("https://cloudflare-dns.com/dns-query")
            .map_err(|_| SsrfError::DnsResolutionFailed)?;
        doh_url
            .query_pairs_mut()
            .append_pair("name", domain)
            .append_pair("type", qtype);

        let headers = worker::Headers::new();
        let _ = headers.set("Accept", "application/dns-json");

        let mut init = worker::RequestInit::new();
        init.with_method(worker::Method::Get);
        init.with_headers(headers);
        init.with_redirect(worker::RequestRedirect::Manual);

        let req = worker::Request::new_with_init(doh_url.as_str(), &init)
            .map_err(|_| SsrfError::DnsResolutionFailed)?;

        let mut resp = worker::Fetch::Request(req)
            .send()
            .await
            .map_err(|_| SsrfError::DnsResolutionFailed)?;

        if resp.status_code() != 200 {
            return Err(SsrfError::DnsResolutionFailed);
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|_| SsrfError::DnsResolutionFailed)?;
        let ips = parse_doh_ips(&bytes)?;
        all_ips.extend(ips);
    }

    validate_resolved_ips(&all_ips)
}

#[cfg(not(target_arch = "wasm32"))]
async fn resolve_domain_and_validate(domain: &str) -> Result<(), SsrfError> {
    use std::net::ToSocketAddrs;
    let addrs = (domain, 443)
        .to_socket_addrs()
        .map_err(|_| SsrfError::DnsResolutionFailed)?;
    let ips: Vec<IpAddr> = addrs.map(|sa| sa.ip()).collect();
    validate_resolved_ips(&ips)
}

/// Performs an SSRF-safe outbound HTTP request:
/// 1. Validates URL syntax, scheme, port, credentials, hostname, and IP literals.
/// 2. Resolves DNS and validates every returned IP address.
/// 3. Disables redirects (`RequestRedirect::Manual`).
/// 4. Enforces a 10-second timeout.
/// 5. Caps the response body read at 1 MB (`1_048_576` bytes).
#[cfg(target_arch = "wasm32")]
pub async fn safe_fetch(
    method: worker::Method,
    raw_url: &str,
    headers: &[(String, String)],
    body: Option<&str>,
    app_origin: &str,
) -> Result<SafeFetchResponse, SsrfError> {
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;

    let url = validate_url_syntax_and_host(raw_url, app_origin)?;
    resolve_and_validate_dns(&url).await?;

    let req_headers = worker::Headers::new();
    for (k, v) in headers {
        req_headers
            .set(k, v)
            .map_err(|e| SsrfError::FetchFailed(format!("invalid header '{k}': {e}")))?;
    }

    let mut init = worker::RequestInit::new();
    init.with_method(method);
    init.with_headers(req_headers);
    init.with_redirect(worker::RequestRedirect::Manual);
    if let Some(b) = body {
        init.with_body(Some(JsValue::from_str(b)));
    }

    let req = worker::Request::new_with_init(url.as_str(), &init)
        .map_err(|e| SsrfError::FetchFailed(e.to_string()))?;

    let abort = worker::AbortController::default();
    let signal = abort.signal();

    let fetch_and_read = async move {
        let resp = worker::Fetch::Request(req)
            .send_with_signal(&signal)
            .await
            .map_err(|e| SsrfError::FetchFailed(e.to_string()))?;

        let status = resp.status_code();
        let resp_headers: Vec<(String, String)> = resp.headers().entries().collect();

        let web_resp: web_sys::Response = resp.into();
        let mut buf = Vec::new();
        let mut truncated = false;

        if let Some(stream) = web_resp.body() {
            let reader: web_sys::ReadableStreamDefaultReader =
                stream.get_reader().unchecked_into();
            loop {
                let chunk_js = JsFuture::from(reader.read())
                    .await
                    .map_err(|e| SsrfError::FetchFailed(format!("{e:?}")))?;
                let done = js_sys::Reflect::get(&chunk_js, &JsValue::from_str("done"))
                    .ok()
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                if done {
                    break;
                }
                let val = js_sys::Reflect::get(&chunk_js, &JsValue::from_str("value"))
                    .map_err(|e| SsrfError::FetchFailed(format!("{e:?}")))?;
                if !val.is_undefined() && !val.is_null() {
                    let arr = js_sys::Uint8Array::new(&val);
                    let len = arr.length() as usize;
                    let remaining = MAX_RESPONSE_BYTES.saturating_sub(buf.len());
                    if len > remaining {
                        if remaining > 0 {
                            let mut tmp = vec![0u8; remaining];
                            arr.slice(0, remaining as u32).copy_to(&mut tmp);
                            buf.extend_from_slice(&tmp);
                        }
                        truncated = true;
                        let _ = reader.cancel();
                        break;
                    } else if len > 0 {
                        let mut tmp = vec![0u8; len];
                        arr.copy_to(&mut tmp);
                        buf.extend_from_slice(&tmp);
                    }
                }
            }
        }

        Ok(SafeFetchResponse {
            status,
            headers: resp_headers,
            body: buf,
            truncated,
        })
    };

    struct TimeoutRace<F> {
        fut: Pin<Box<F>>,
        delay: Pin<Box<worker::Delay>>,
        abort: Option<worker::AbortController>,
    }

    impl<F> Future for TimeoutRace<F>
    where
        F: Future<Output = Result<SafeFetchResponse, SsrfError>>,
    {
        type Output = Result<SafeFetchResponse, SsrfError>;

        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            if let Poll::Ready(res) = self.fut.as_mut().poll(cx) {
                return Poll::Ready(res);
            }
            if let Poll::Ready(()) = self.delay.as_mut().poll(cx) {
                if let Some(ctrl) = self.abort.take() {
                    ctrl.abort();
                }
                return Poll::Ready(Err(SsrfError::Timeout));
            }
            Poll::Pending
        }
    }

    TimeoutRace {
        fut: Box::pin(fetch_and_read),
        delay: Box::pin(worker::Delay::from(Duration::from_millis(FETCH_TIMEOUT_MS))),
        abort: Some(abort),
    }
    .await
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn safe_fetch(
    _method: worker::Method,
    raw_url: &str,
    _headers: &[(String, String)],
    _body: Option<&str>,
    app_origin: &str,
) -> Result<SafeFetchResponse, SsrfError> {
    let url = validate_url_syntax_and_host(raw_url, app_origin)?;
    resolve_and_validate_dns(&url).await?;
    Err(SsrfError::FetchFailed(
        "outbound fetch is only available in wasm32 worker runtime".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP_ORIGIN: &str = "https://hub.example.com";

    #[test]
    fn allows_valid_public_urls() {
        assert!(validate_url_syntax_and_host("https://api.github.com/events", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("http://example.com/hook", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("https://example.com:443/hook", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("http://example.com:80/hook", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("https://8.8.8.8/dns-query", APP_ORIGIN).is_ok());
        assert!(
            validate_url_syntax_and_host("https://[2606:4700:4700::1111]/", APP_ORIGIN).is_ok()
        );
        assert!(
            validate_url_syntax_and_host("https://[::ffff:8.8.8.8]/", APP_ORIGIN).is_ok()
        );
    }

    #[test]
    fn rejects_schemes_ports_credentials_and_malformed_urls() {
        assert_eq!(
            validate_url_syntax_and_host("", APP_ORIGIN),
            Err(SsrfError::InvalidUrl)
        );
        assert_eq!(
            validate_url_syntax_and_host("not a url", APP_ORIGIN),
            Err(SsrfError::InvalidUrl)
        );
        assert_eq!(
            validate_url_syntax_and_host("ftp://example.com/file", APP_ORIGIN),
            Err(SsrfError::UnsupportedScheme)
        );
        assert_eq!(
            validate_url_syntax_and_host("file:///etc/passwd", APP_ORIGIN),
            Err(SsrfError::UnsupportedScheme)
        );
        assert_eq!(
            validate_url_syntax_and_host("gopher://example.com/", APP_ORIGIN),
            Err(SsrfError::UnsupportedScheme)
        );
        assert_eq!(
            validate_url_syntax_and_host("https://user:pass@example.com/", APP_ORIGIN),
            Err(SsrfError::CredentialsInUrl)
        );
        assert_eq!(
            validate_url_syntax_and_host("https://user@example.com/", APP_ORIGIN),
            Err(SsrfError::CredentialsInUrl)
        );
        assert_eq!(
            validate_url_syntax_and_host("https://example.com:8080/", APP_ORIGIN),
            Err(SsrfError::DisallowedPort)
        );
        assert_eq!(
            validate_url_syntax_and_host("http://example.com:22/", APP_ORIGIN),
            Err(SsrfError::DisallowedPort)
        );
    }

    #[test]
    fn rejects_blocked_hostnames_and_app_origin() {
        let blocked = [
            "http://localhost/admin",
            "http://localhost./admin",
            "http://LOCALHOST/admin",
            "http://api.localhost/admin",
            "http://printer.local/status",
            "http://service.internal/meta",
            "http://host.localdomain/x",
            "http://metadata.google.internal/computeMetadata/v1/",
            "https://hub.example.com/api/me",
            "https://HUB.EXAMPLE.COM./api/me",
        ];
        for url in blocked {
            assert_eq!(
                validate_url_syntax_and_host(url, APP_ORIGIN),
                Err(SsrfError::BlockedHost),
                "expected BlockedHost for {url}"
            );
        }
    }

    #[test]
    fn rejects_all_blocked_ipv4_ranges() {
        let blocked_ips = [
            "http://0.0.0.0/",
            "http://0.1.2.3/",
            "http://10.0.0.1/",
            "http://10.255.255.254/",
            "http://100.64.0.1/",
            "http://100.127.255.254/",
            "http://127.0.0.1/",
            "http://127.0.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.0.1/",
            "http://172.16.0.1/",
            "http://172.31.255.254/",
            "http://192.0.0.1/",
            "http://192.0.2.1/",
            "http://192.168.1.1/",
            "http://198.18.0.1/",
            "http://198.19.255.254/",
            "http://198.51.100.1/",
            "http://203.0.113.1/",
            "http://224.0.0.1/",
            "http://239.255.255.255/",
            "http://240.0.0.1/",
            "http://255.255.255.255/",
            // Decimal / hex / octal encodings parsed by url crate
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0177.0.0.1/",
            "http://017700000001/",
            "  http://127.0.0.1/  ",
        ];
        for url in blocked_ips {
            assert_eq!(
                validate_url_syntax_and_host(url, APP_ORIGIN),
                Err(SsrfError::BlockedIp),
                "expected BlockedIp for {url}"
            );
        }

        // Boundary public IPs adjacent to CGNAT / RFC1918 must be allowed
        assert!(validate_url_syntax_and_host("https://100.63.255.255/", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("https://100.128.0.1/", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("https://172.15.255.255/", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("https://172.32.0.1/", APP_ORIGIN).is_ok());
        assert!(validate_url_syntax_and_host("https://192.169.0.1/", APP_ORIGIN).is_ok());
    }

    #[test]
    fn rejects_all_blocked_ipv6_ranges_and_ipv4_mapped() {
        let blocked_v6 = [
            "http://[::]/",
            "http://[::1]/",
            "http://[fc00::1]/",
            "http://[fd12:3456:789a::1]/",
            "http://[fe80::1]/",
            "http://[febf::1]/",
            "http://[ff02::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:7f00:1]/",
            "http://[::ffff:10.0.0.1]/",
            "http://[::ffff:100.64.0.1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[::ffff:172.16.0.1]/",
            "http://[::ffff:192.168.1.1]/",
            "http://[::127.0.0.1]/",
            "http://[64:ff9b::127.0.0.1]/",
            "http://[64:ff9b::8.8.8.8]/",
            "http://[100::1]/",
            "http://[2001:db8::1]/",
        ];
        for url in blocked_v6 {
            assert_eq!(
                validate_url_syntax_and_host(url, APP_ORIGIN),
                Err(SsrfError::BlockedIp),
                "expected BlockedIp for {url}"
            );
        }
    }

    #[test]
    fn doh_parser_and_validator_blocks_private_dns_answers() {
        let private_doh = br#"{
            "Status": 0,
            "Answer": [
                { "name": "rebind.example.com", "type": 5, "data": "internal.target." },
                { "name": "internal.target", "type": 1, "data": "93.184.216.34" },
                { "name": "internal.target", "type": 1, "data": "169.254.169.254" }
            ]
        }"#;
        let ips = parse_doh_ips(private_doh).unwrap();
        assert_eq!(ips.len(), 2);
        assert_eq!(validate_resolved_ips(&ips), Err(SsrfError::BlockedIp));

        let empty_doh = br#"{"Status": 3, "Answer": []}"#;
        let ips_empty = parse_doh_ips(empty_doh).unwrap();
        assert_eq!(
            validate_resolved_ips(&ips_empty),
            Err(SsrfError::DnsResolutionFailed)
        );

        let servfail_doh = br#"{"Status": 2, "Answer": [{"type": 1, "data": "93.184.216.34"}]}"#;
        assert_eq!(
            parse_doh_ips(servfail_doh),
            Err(SsrfError::DnsResolutionFailed)
        );

        let public_doh = br#"{
            "Status": 0,
            "Answer": [
                { "name": "example.com", "type": 1, "data": "93.184.216.34" },
                { "name": "example.com", "type": 28, "data": "2606:2800:220:1:248:1893:25c8:1946" }
            ]
        }"#;
        let ips_public = parse_doh_ips(public_doh).unwrap();
        assert!(validate_resolved_ips(&ips_public).is_ok());
    }
}

//! FetchUrl — HTTP fetcher with SSRF protection and HTML content extraction.
//!
//! Ported for `kimi-agent` (P26 批 2). Executes in-process in Rust using
//! `reqwest` and `scraper`. When the host resolves a
//! `[services.moonshot_fetch]` backend (v2 `configSection.ts`), the fetch is
//! tried through the Moonshot service first — `POST {base_url}` with
//! `{"url": …}`, `Accept: text/markdown`, the response body being the
//! extracted markdown (v2 `MoonshotFetchURLProvider`) — and the direct fetch
//! below stays the fallback on any service failure.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use scraper::{Html, Selector};
use serde_json::{Value, json};
use url::Url;

use super::moonshot_service::{self, MoonshotServiceConfig};
use crate::turn_loop::types::ExecutableToolResult;

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
const DEFAULT_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Redirect hops followed before giving up — the cap `Policy::limited` used.
const MAX_REDIRECT_HOPS: usize = 10;

/// One host-resolved `[services.moonshot_fetch]` backend (v2
/// `MoonshotFetchURLProvider`). Set per pipeline build from session params;
/// the tool consults it at execution time.
pub type WebFetchServiceConfig = MoonshotServiceConfig;

static SERVICE_CONFIG: LazyLock<Mutex<Option<MoonshotServiceConfig>>> =
    LazyLock::new(|| Mutex::new(None));

/// Install (or clear with `None`) the host-resolved Moonshot fetch backend.
/// Always installed per pipeline build — including `None` — so a backend
/// resolved for one session never leaks into the next.
pub fn set_service_config(config: Option<MoonshotServiceConfig>) {
    moonshot_service::install(&SERVICE_CONFIG, config);
}

fn service_config() -> Option<MoonshotServiceConfig> {
    moonshot_service::current(&SERVICE_CONFIG)
}

/// Build the Moonshot fetch request: body and headers (bearer, Accept,
/// content-type, custom headers win).
pub fn moonshot_fetch_request_parts(
    config: &MoonshotServiceConfig,
    url: &str,
    api_key: &str,
    tool_call_id: Option<&str>,
) -> (String, String, Vec<(String, String)>) {
    let body = json!({ "url": url }).to_string();
    let headers = moonshot_service::bearer_headers(
        api_key,
        &config.custom_headers,
        &[("Accept", "text/markdown")],
        tool_call_id,
    );
    (config.base_url.clone(), body, headers)
}

/// Try the Moonshot fetch service. `Ok(Some(result))` = the service answered
/// (success or a tool-level error result); `Ok(None)` = the service failed
/// and the caller should fall back to the direct fetch (v2 `localFallback`).
/// Fallbacks log at debug: the outcome is routine, the reason aids diagnosis.
async fn fetch_via_moonshot(
    config: &MoonshotServiceConfig,
    url_str: &str,
    tool_call_id: Option<&str>,
) -> Result<Option<ExecutableToolResult>, ()> {
    let Some(api_key) = moonshot_service::non_blank_key(&config.api_key) else {
        // Unconfigured credential: a service error, but v2 treats any failure
        // as fallback-worthy — the direct fetch still runs.
        tracing::debug!("moonshot fetch skipped (missing API key), falling back to direct fetch");
        return Err(());
    };
    let (url, body, headers) =
        moonshot_fetch_request_parts(config, url_str, &api_key, tool_call_id);
    let client = match moonshot_service::build_client() {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!(
                "moonshot fetch skipped (client build: {e}), falling back to direct fetch"
            );
            return Err(());
        }
    };
    let request = moonshot_service::apply_headers(client.post(&url).body(body), headers);
    let response = match request.send().await {
        Ok(resp) => resp,
        Err(e) => {
            tracing::debug!("moonshot fetch failed (network: {e}), falling back to direct fetch");
            return Err(());
        }
    };
    let status = response.status();
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            tracing::debug!("moonshot fetch failed (read body: {e}), falling back to direct fetch");
            return Err(());
        }
    };
    if status.as_u16() != 200 {
        // Mirror v2: any non-200 falls back to the local fetcher.
        tracing::debug!("moonshot fetch failed (HTTP {status}), falling back to direct fetch");
        return Err(());
    }
    Ok(Some(ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: text,
        is_error: false,
        note: None,
    }))
}

pub async fn execute_fetch_url(
    args: &Value,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    let url_str = args.get("url")?.as_str()?;
    if url_str.trim().is_empty() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: "URL parameter cannot be empty".to_string(),
            is_error: true,
            note: None,
        });
    }

    // Host-resolved `[services.moonshot_fetch]` backend first; the direct
    // fetch below is the fallback (v2 `MoonshotFetchURLProvider.localFallback`).
    if let Some(config) = service_config()
        && let Ok(Some(result)) = fetch_via_moonshot(&config, url_str, tool_call_id).await
    {
        return Some(result);
    }

    let mut current_url = url_str.to_string();
    let mut redirects: usize = 0;

    let response = loop {
        let parsed = match Url::parse(&current_url) {
            Ok(p) => p,
            Err(e) => {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: format!("Failed to fetch URL: Invalid URL: {e}"),
                    is_error: true,
                    note: None,
                });
            }
        };

        let addrs = match resolve_and_validate_url(&parsed, false) {
            Ok(a) => a,
            Err(err) => {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: format!("Failed to fetch URL: {err}"),
                    is_error: true,
                    note: None,
                });
            }
        };

        let host = match parsed.host_str() {
            Some(h) => h,
            None => {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: "Failed to fetch URL: URL has no host".to_string(),
                    is_error: true,
                    note: None,
                });
            }
        };

        // Pin the resolved public addresses into reqwest to close the
        // DNS-rebinding / TOCTOU window (mirroring kimi-native-tools).
        let mut builder = reqwest::Client::builder()
            .user_agent(DEFAULT_USER_AGENT)
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none());

        if !addrs.is_empty() {
            builder = builder.resolve_to_addrs(host, &addrs);
        }

        let client = match builder.build() {
            Ok(c) => c,
            Err(e) => {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: format!("Failed to initialize HTTP client: {e}"),
                    is_error: true,
                    note: None,
                });
            }
        };

        let resp = match client.get(&current_url).send().await {
            Ok(r) => r,
            Err(e) => {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: format!(
                        "Failed to fetch URL due to network error: {current_url}. {e}"
                    ),
                    is_error: true,
                    note: None,
                });
            }
        };

        let status = resp.status();
        if status.is_redirection() {
            if redirects >= MAX_REDIRECT_HOPS {
                return Some(ExecutableToolResult {
                    delivery: None,
                    stop_turn: false,
                    content: format!(
                        "Failed to fetch URL: too many redirects (max {MAX_REDIRECT_HOPS})"
                    ),
                    is_error: true,
                    note: None,
                });
            }
            redirects += 1;
            let location = match resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            {
                Some(loc) => loc,
                None => {
                    return Some(ExecutableToolResult {
                        delivery: None,
                        stop_turn: false,
                        content: "Failed to fetch URL: Redirect without Location header"
                            .to_string(),
                        is_error: true,
                        note: None,
                    });
                }
            };
            match parsed.join(location) {
                Ok(next) => {
                    current_url = next.to_string();
                    continue;
                }
                Err(e) => {
                    return Some(ExecutableToolResult {
                        delivery: None,
                        stop_turn: false,
                        content: format!("Failed to fetch URL: Invalid redirect URL: {e}"),
                        is_error: true,
                        note: None,
                    });
                }
            }
        }

        break resp;
    };

    let status = response.status();
    if !status.is_success() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: format!("Failed to fetch URL. Status: {status}."),
            is_error: true,
            note: None,
        });
    }

    let is_html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/html") || ct.contains("application/xhtml+xml"))
        .unwrap_or(false);

    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return Some(ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: format!("Failed to read response body: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    if bytes.is_empty() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: "The response body is empty.".to_string(),
            is_error: false,
            note: None,
        });
    }

    if bytes.len() > DEFAULT_MAX_BYTES {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: format!("Response body too large: exceeds limit ({DEFAULT_MAX_BYTES} bytes)."),
            is_error: true,
            note: None,
        });
    }

    let body_text = String::from_utf8_lossy(&bytes).to_string();

    let (content, kind) = if is_html
        || body_text.trim_start().starts_with("<!DOCTYPE")
        || body_text.trim_start().starts_with("<html")
    {
        let extracted = extract_html_content(&body_text);
        if extracted.is_empty() {
            (body_text, "passthrough")
        } else {
            (extracted, "extracted")
        }
    } else {
        (body_text, "passthrough")
    };

    let note = if kind == "passthrough" {
        "The returned content is the full response body, returned verbatim."
    } else {
        "The returned content is the main text extracted from the page."
    };

    let cite_reminder =
        "If you use it in your answer, cite this page as a markdown link, e.g. [title](url).";
    let formatted = format!("{note} {cite_reminder}\n\n{content}");

    Some(ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: formatted,
        is_error: false,
        note: None,
    })
}

// ── SSRF Validation ──────────────────────────────────────────────────────────

pub fn resolve_and_validate_url(
    parsed: &Url,
    allow_private: bool,
) -> Result<Vec<SocketAddr>, String> {
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Unsupported scheme \"{scheme}\" — only http(s) allowed."
            ));
        }
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;

    let port = parsed.port_or_known_default().unwrap_or(80);

    let host_lower = host.to_lowercase();
    if !allow_private && (host_lower == "localhost" || host_lower.ends_with(".localhost")) {
        return Err(format!("Refusing to fetch private host: \"{host}\""));
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if !allow_private && is_private_ip(ip) {
            return Err(format!("Refusing to fetch private address: \"{host}\""));
        }
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    let addrs: Vec<SocketAddr> = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve host \"{host}\": {e}"))?
        .collect();

    if addrs.is_empty() {
        return Err(format!("Cannot resolve host \"{host}\": no addresses"));
    }

    if !allow_private {
        for addr in &addrs {
            if is_private_ip(addr.ip()) {
                return Err(format!(
                    "Refusing to fetch host \"{host}\": resolves to private address \"{}\".",
                    addr.ip()
                ));
            }
        }
    }

    Ok(addrs)
}

pub fn validate_url(url_str: &str, allow_private: bool) -> Result<(), String> {
    let parsed = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;
    resolve_and_validate_url(&parsed, allow_private).map(|_| ())
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    if octets[0] == 0 || octets[0] == 10 || octets[0] == 127 {
        return true;
    }
    if octets[0] == 100 && (octets[1] & 0xC0) == 64 {
        return true;
    }
    if octets[0] == 169 && octets[1] == 254 {
        return true;
    }
    if octets[0] == 172 && (octets[1] & 0xF0) == 16 {
        return true;
    }
    if octets[0] == 192 && octets[1] == 168 {
        return true;
    }
    false
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip == Ipv6Addr::LOCALHOST {
        return true;
    }
    let segments = ip.segments();
    if (segments[0] & 0xFE00) == 0xFC00 || (segments[0] & 0xFFC0) == 0xFE80 {
        return true;
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_ipv4(v4);
    }
    false
}

// ── HTML Extraction ──────────────────────────────────────────────────────────

pub fn extract_html_content(html: &str) -> String {
    let document = Html::parse_document(html);

    let title = selector("title")
        .and_then(|sel| document.select(&sel).next())
        .map(|el| clean_text(&el.text().collect::<String>()))
        .unwrap_or_default();

    let content = try_extract_container(&document, "article")
        .or_else(|| try_extract_container(&document, "main"))
        .or_else(|| try_extract_container(&document, "body"))
        .unwrap_or_default();

    if content.is_empty() {
        return String::new();
    }

    if title.is_empty() {
        content
    } else {
        format!("# {title}\n\n{content}")
    }
}

fn try_extract_container(document: &Html, tag: &str) -> Option<String> {
    let sel = selector(tag)?;
    let element = document.select(&sel).next()?;

    let noise_tags: &[&str] = &[
        "script", "style", "nav", "header", "footer", "aside", "noscript", "svg", "iframe",
    ];
    let mut text_parts: Vec<String> = Vec::new();

    collect_text_excluding(element, noise_tags, &mut text_parts);

    let combined = text_parts.join(" ");
    let cleaned = clean_text(&combined);

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn collect_text_excluding(
    element: scraper::ElementRef,
    exclude_tags: &[&str],
    output: &mut Vec<String>,
) {
    for child in element.children() {
        match child.value() {
            scraper::node::Node::Text(text) => {
                let t = text.trim();
                if !t.is_empty() {
                    output.push(t.to_string());
                }
            }
            scraper::node::Node::Element(el) => {
                let tag_name = el.name();
                if exclude_tags.contains(&tag_name) {
                    continue;
                }
                if let Some(child_ref) = scraper::ElementRef::wrap(child) {
                    collect_text_excluding(child_ref, exclude_tags, output);
                }
            }
            _ => {}
        }
    }
}

fn clean_text(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_whitespace = false;

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !in_whitespace {
                result.push(' ');
                in_whitespace = true;
            }
        } else {
            result.push(ch);
            in_whitespace = false;
        }
    }

    result.trim().to_string()
}

fn selector(s: &str) -> Option<Selector> {
    Selector::parse(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_url_schemes() {
        assert!(validate_url("https://example.com", false).is_ok());
        assert!(validate_url("http://example.com/foo", false).is_ok());

        let ftp_err = validate_url("ftp://example.com", false).unwrap_err();
        assert_eq!(
            ftp_err,
            "Unsupported scheme \"ftp\" — only http(s) allowed."
        );

        let file_err = validate_url("file:///etc/passwd", false).unwrap_err();
        assert_eq!(
            file_err,
            "Unsupported scheme \"file\" — only http(s) allowed."
        );

        let relative_err = validate_url("/local/path", false).unwrap_err();
        assert!(relative_err.starts_with("Invalid URL:"));
    }

    #[test]
    fn test_moonshot_fetch_request_parts() {
        let config = WebFetchServiceConfig {
            base_url: "https://api.example.test/coding/v1/fetch".into(),
            api_key: Some("sk-test".into()),
            custom_headers: [("X-Trace".to_string(), "t1".to_string())]
                .into_iter()
                .collect(),
        };
        let (url, body, headers) = moonshot_fetch_request_parts(
            &config,
            "https://docs.example.test/guide",
            "sk-test",
            Some("call-7"),
        );
        assert_eq!(url, "https://api.example.test/coding/v1/fetch");
        assert_eq!(body, r#"{"url":"https://docs.example.test/guide"}"#);
        assert!(headers.contains(&("Authorization".to_string(), "Bearer sk-test".to_string())));
        assert!(headers.contains(&("Accept".to_string(), "text/markdown".to_string())));
        assert!(headers.contains(&("Content-Type".to_string(), "application/json".to_string())));
        assert!(headers.contains(&("X-Msh-Tool-Call-Id".to_string(), "call-7".to_string())));
        assert!(headers.contains(&("X-Trace".to_string(), "t1".to_string())));
        // The tool-call id rides after Content-Type and before custom
        // headers, mirroring v2's header order.
        let names: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
        let id_pos = names
            .iter()
            .position(|k| *k == "X-Msh-Tool-Call-Id")
            .unwrap();
        assert!(names[..id_pos].contains(&"Content-Type"));
        assert!(!names[..id_pos].contains(&"X-Trace"));
    }

    #[test]
    fn test_validate_url_ssrf_private_ips() {
        assert!(validate_url("http://127.0.0.1/test", false).is_err());
        assert!(validate_url("http://localhost/test", false).is_err());
        assert!(validate_url("http://my.localhost:8080/test", false).is_err());
        assert!(validate_url("http://10.0.0.1/admin", false).is_err());
        assert!(validate_url("http://192.168.1.1/", false).is_err());
        assert!(validate_url("http://172.16.0.1/", false).is_err());
        assert!(validate_url("http://[::1]/", false).is_err());
    }

    #[test]
    fn test_html_extraction_with_article() {
        let html = r#"
            <!DOCTYPE html>
            <html>
            <head><title>My Great Article</title></head>
            <body>
                <header><nav><a href="/">Home</a></nav></header>
                <article>
                    <h1>Article Heading</h1>
                    <p>This is the first paragraph with important text.</p>
                    <p>And here is the second paragraph.</p>
                </article>
                <footer>Copyright 2026</footer>
                <script>console.log('noise');</script>
            </body>
            </html>
        "#;
        let extracted = extract_html_content(html);
        assert!(extracted.contains("# My Great Article"));
        assert!(extracted.contains("Article Heading"));
        assert!(extracted.contains("This is the first paragraph"));
        assert!(!extracted.contains("Copyright 2026"));
        assert!(!extracted.contains("console.log"));
        assert!(!extracted.contains("Home"));
    }

    #[test]
    fn test_clean_text_whitespace() {
        let raw = "   hello   \n\n\t  world  !  ";
        assert_eq!(clean_text(raw), "hello world !");
    }

    #[test]
    fn test_resolve_and_validate_url_pinning() {
        let parsed_public = Url::parse("http://1.1.1.1/").unwrap();
        let addrs = resolve_and_validate_url(&parsed_public, false).unwrap();
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].ip(), "1.1.1.1".parse::<IpAddr>().unwrap());
        assert_eq!(addrs[0].port(), 80);

        let parsed_private = Url::parse("http://10.255.0.1:8080/").unwrap();
        let err = resolve_and_validate_url(&parsed_private, false).unwrap_err();
        assert!(err.contains("Refusing to fetch private address"));

        let parsed_localhost = Url::parse("http://localhost:3000/").unwrap();
        let err_lh = resolve_and_validate_url(&parsed_localhost, false).unwrap_err();
        assert!(err_lh.contains("Refusing to fetch private host"));
    }
}

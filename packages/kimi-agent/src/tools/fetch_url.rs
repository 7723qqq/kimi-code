//! FetchUrl — HTTP fetcher with SSRF protection and HTML content extraction.
//!
//! Ported for `kimi-agent` (P26 批 2). Executes in-process in Rust using
//! `reqwest` and `scraper`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::time::Duration;

use scraper::{Html, Selector};
use serde_json::Value;
use url::Url;

use crate::turn_loop::types::ExecutableToolResult;

const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
const DEFAULT_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Redirect hops followed before giving up — the cap `Policy::limited` used.
const MAX_REDIRECT_HOPS: usize = 10;

pub async fn execute_fetch_url(args: &Value) -> Option<ExecutableToolResult> {
    let url_str = args.get("url")?.as_str()?;
    if url_str.trim().is_empty() {
        return Some(ExecutableToolResult {
            content: "URL parameter cannot be empty".to_string(),
            is_error: true,
            note: None,
        });
    }

    if let Err(err) = validate_url(url_str, false) {
        return Some(ExecutableToolResult {
            content: format!("Failed to fetch URL: {err}"),
            is_error: true,
            note: None,
        });
    }

    let client = match reqwest::Client::builder()
        .user_agent(DEFAULT_USER_AGENT)
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        // SSRF: the model's URL is only the first hop. `Policy::limited`
        // would let reqwest follow a public page's 302 straight to a loopback
        // or link-local address unchecked, so every target is validated before
        // it is followed — the same per-hop rule
        // `kimi-native-tools/src/fetch_url.rs:76` implements.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECT_HOPS {
                return attempt.error("too many redirects");
            }
            match validate_url(attempt.url().as_str(), false) {
                Ok(()) => attempt.follow(),
                Err(reason) => attempt.error(reason),
            }
        }))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Some(ExecutableToolResult {
                content: format!("Failed to initialize HTTP client: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    let response = match client.get(url_str).send().await {
        Ok(resp) => resp,
        Err(e) => {
            return Some(ExecutableToolResult {
                content: format!("Failed to fetch URL due to network error: {url_str}. {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    let status = response.status();
    if !status.is_success() {
        return Some(ExecutableToolResult {
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
                content: format!("Failed to read response body: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    if bytes.is_empty() {
        return Some(ExecutableToolResult {
            content: "The response body is empty.".to_string(),
            is_error: false,
            note: None,
        });
    }

    if bytes.len() > DEFAULT_MAX_BYTES {
        return Some(ExecutableToolResult {
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
        content: formatted,
        is_error: false,
        note: None,
    })
}

// ── SSRF Validation ──────────────────────────────────────────────────────────

pub fn validate_url(url_str: &str, allow_private: bool) -> Result<(), String> {
    let parsed = Url::parse(url_str).map_err(|e| format!("Invalid URL: {e}"))?;

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

    if allow_private {
        return Ok(());
    }

    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".localhost") {
        return Err(format!("Refusing to fetch private host: \"{host}\""));
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_ip(ip) {
            return Err(format!("Refusing to fetch private address: \"{host}\""));
        }
        return Ok(());
    }

    let port = parsed.port_or_known_default().unwrap_or(80);
    if let Ok(addrs) = format!("{host}:{port}").to_socket_addrs() {
        for addr in addrs {
            if is_private_ip(addr.ip()) {
                return Err(format!(
                    "Refusing to fetch host \"{host}\": resolves to private address \"{}\".",
                    addr.ip()
                ));
            }
        }
    }

    Ok(())
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
        assert!(validate_url("ftp://example.com", false).is_err());
        assert!(validate_url("file:///etc/passwd", false).is_err());
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
}

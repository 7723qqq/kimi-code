//! WebSearch — DuckDuckGo HTML scraping without API keys.
//!
//! Ported for `kimi-agent` (P26 批 2). Posts search queries to DuckDuckGo,
//! parses HTML results with `scraper`, and formats them for the LLM.
//! When the host resolves a `[services.moonshot_search]` backend (v2
//! `configSection.ts`), the Moonshot service is called instead: `POST
//! {base_url}` with `{"text_query": …}` and a bearer credential, response
//! `{ "search_results": […] }` (v2 `MoonshotWebSearchProvider`).

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use scraper::{Html, Selector};
use serde_json::{Value, json};

use super::moonshot_service::{self, MoonshotServiceConfig};
use crate::turn_loop::types::ExecutableToolResult;

const DDG_HTML_URL: &str = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_RESULTS: usize = 10;

#[derive(Debug, Clone)]
pub struct WebSearchResultEntry {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub site_name: Option<String>,
    pub date: Option<String>,
}

/// One host-resolved `[services.moonshot_search]` backend (v2
/// `MoonshotWebSearchProvider`). Set per pipeline build from session params;
/// the tool consults it at execution time.
pub type WebSearchServiceConfig = MoonshotServiceConfig;

static SERVICE_CONFIG: LazyLock<Mutex<Option<MoonshotServiceConfig>>> =
    LazyLock::new(|| Mutex::new(None));

/// Install (or clear with `None`) the host-resolved Moonshot search backend.
/// Always installed per pipeline build — including `None` — so a backend
/// resolved for one session never leaks into the next.
pub fn set_service_config(config: Option<MoonshotServiceConfig>) {
    moonshot_service::install(&SERVICE_CONFIG, config);
}

fn service_config() -> Option<MoonshotServiceConfig> {
    moonshot_service::current(&SERVICE_CONFIG)
}

/// Build the Moonshot search request: body, URL, and headers (bearer,
/// content-type, optional tool-call id, custom headers win).
pub fn moonshot_search_request_parts(
    config: &MoonshotServiceConfig,
    query: &str,
    api_key: &str,
    tool_call_id: Option<&str>,
) -> (String, String, Vec<(String, String)>) {
    let body = json!({ "text_query": query }).to_string();
    let headers =
        moonshot_service::bearer_headers(api_key, &config.custom_headers, &[], tool_call_id);
    (config.base_url.clone(), body, headers)
}

/// Parse a Moonshot search response (`{"search_results": […]}`) into the
/// tool's result entries, mirroring v2's field mapping and defaults.
pub fn parse_moonshot_search_response(body: &str) -> Result<Vec<WebSearchResultEntry>, String> {
    let json: Value = serde_json::from_str(body).map_err(|e| format!("invalid JSON: {e}"))?;
    let raw = match json.get("search_results").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Ok(Vec::new()),
    };
    let mut results = Vec::with_capacity(raw.len());
    for entry in raw {
        let text = |key: &str| {
            entry
                .get(key)
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty())
        };
        results.push(WebSearchResultEntry {
            title: text("title").unwrap_or_default(),
            url: text("url").unwrap_or_default(),
            snippet: text("snippet").unwrap_or_default(),
            site_name: text("site_name"),
            date: text("date"),
        });
    }
    Ok(results)
}

fn format_search_results(results: Vec<WebSearchResultEntry>) -> String {
    let mut output = String::new();
    let mut first = true;
    for result in results {
        if !first {
            output.push_str("---\n\n");
        }
        first = false;
        output.push_str(&format!("Title: {}\n", result.title));
        if let Some(ref site) = result.site_name {
            output.push_str(&format!("Site: {site}\n"));
        }
        if let Some(ref date) = result.date {
            output.push_str(&format!("Date: {date}\n"));
        }
        output.push_str(&format!("URL: {}\n", result.url));
        output.push_str(&format!("Snippet: {}\n\n", result.snippet));
    }
    output.push_str("When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).");
    output
}

fn err_result(content: String) -> ExecutableToolResult {
    ExecutableToolResult {
        stop_turn: false,
        content,
        is_error: true,
        note: None,
    }
}

async fn search_via_moonshot(
    config: &MoonshotServiceConfig,
    query: &str,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    // A missing credential is a tool error here, not a fallback: when a
    // search backend is configured it *replaces* the DDG scrape, so there
    // is nothing to fall back to. FetchURL differs — its service is tried
    // first with the direct fetch as fallback.
    let Some(api_key) = moonshot_service::non_blank_key(&config.api_key) else {
        return Some(err_result(
            "Moonshot search service is not configured: missing API key.".to_string(),
        ));
    };
    let (url, body, headers) = moonshot_search_request_parts(config, query, &api_key, tool_call_id);
    let client = match moonshot_service::build_client() {
        Ok(c) => c,
        Err(e) => {
            return Some(err_result(format!(
                "Search failed: Failed to initialize HTTP client: {e}"
            )));
        }
    };
    let mut request = client.post(&url).body(body);
    request = moonshot_service::apply_headers(request, headers);
    let response = match request.send().await {
        Ok(resp) => resp,
        Err(e) => {
            let msg = if e.is_timeout() {
                format!("Search timed out: {e}")
            } else {
                format!("Search failed (network): {e}")
            };
            return Some(err_result(msg));
        }
    };
    let status = response.status();
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return Some(err_result(format!(
                "Search failed: failed to read response body: {e}"
            )));
        }
    };
    if status.as_u16() != 200 {
        // v2 errors on any non-200 (401 gets the auth qualifier); the
        // service replaces the scrape, so this is a tool error, not a
        // fallback.
        let qualifier = if status.as_u16() == 401 {
            " (auth/unauthorized)"
        } else {
            ""
        };
        return Some(err_result(format!(
            "Moonshot search request failed: HTTP {status}{qualifier}. {}",
            text.trim()
        )));
    }
    let results = match parse_moonshot_search_response(&text) {
        Ok(r) => r,
        Err(e) => return Some(err_result(format!("Search failed: {e}"))),
    };
    if results.is_empty() {
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: "No search results found.".to_string(),
            is_error: false,
            note: None,
        });
    }
    Some(ExecutableToolResult {
        stop_turn: false,
        content: format_search_results(results),
        is_error: false,
        note: None,
    })
}

pub async fn execute_web_search(
    args: &Value,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    let query = args.get("query")?.as_str()?;
    if query.trim().is_empty() {
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: "Query parameter cannot be empty".to_string(),
            is_error: true,
            note: None,
        });
    }

    // A host-resolved `[services.moonshot_search]` backend replaces the DDG
    // scrape (v2 `WebSearchProviderService.fromServicesConfig`).
    if let Some(config) = service_config() {
        return search_via_moonshot(&config, query, tool_call_id).await;
    }

    let client = match reqwest::Client::builder()
        .user_agent(DDG_USER_AGENT)
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Search failed: Failed to initialize HTTP client: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    let form_body = format!("q={}", urlencoded(query));
    let response = match client
        .post(DDG_HTML_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "*/*")
        .header("Host", "html.duckduckgo.com")
        .body(form_body)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            let msg = if e.is_timeout() {
                format!("Search timed out: {e}")
            } else {
                format!("Search failed (network): {e}")
            };
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: msg,
                is_error: true,
                note: None,
            });
        }
    };

    let status = response.status();
    if !status.is_success() {
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: format!("Search failed: DuckDuckGo search returned HTTP {status}"),
            is_error: true,
            note: None,
        });
    }

    let body = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Search failed: Failed to read response body: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    let results = match parse_ddg_results(&body, MAX_RESULTS) {
        Ok(res) => res,
        Err(e) => {
            return Some(ExecutableToolResult {
                stop_turn: false,
                content: format!("Search failed: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    if results.is_empty() {
        return Some(ExecutableToolResult {
            stop_turn: false,
            content: "No search results found.".to_string(),
            is_error: false,
            note: None,
        });
    }

    // One renderer for both paths (v2 formats in `webSearchTool`); DDG
    // entries carry no date, so no `Date:` line is emitted for them.
    Some(ExecutableToolResult {
        stop_turn: false,
        content: format_search_results(results),
        is_error: false,
        note: None,
    })
}

// ── HTML Parsing ─────────────────────────────────────────────────────────────

pub fn parse_ddg_results(
    html: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResultEntry>, String> {
    let document = Html::parse_document(html);

    let result_sel =
        Selector::parse("div.result").map_err(|_| "Failed to parse selector".to_string())?;
    let title_sel =
        Selector::parse("a.result__a").map_err(|_| "Failed to parse selector".to_string())?;
    let snippet_sel =
        Selector::parse(".result__snippet").map_err(|_| "Failed to parse selector".to_string())?;
    let url_sel =
        Selector::parse(".result__url").map_err(|_| "Failed to parse selector".to_string())?;

    let mut results = Vec::new();

    for element in document.select(&result_sel) {
        if results.len() >= max_results {
            break;
        }

        // Skip ads
        let classes = element.value().attr("class").unwrap_or("");
        if classes.contains("result--ad") {
            continue;
        }

        let title_el = match element.select(&title_sel).next() {
            Some(el) => el,
            None => continue,
        };
        let title: String = title_el.text().collect::<String>().trim().to_string();
        let url = title_el.value().attr("href").unwrap_or("").to_string();

        if title.is_empty() || url.is_empty() {
            continue;
        }

        let snippet = element
            .select(&snippet_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let site_name = element
            .select(&url_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty());

        results.push(WebSearchResultEntry {
            title,
            url,
            snippet,
            site_name,
            // The DDG scrape carries no publication date (v2 only maps
            // `date` on the Moonshot provider path).
            date: None,
        });
    }

    Ok(results)
}

// ── URL encoding ─────────────────────────────────────────────────────────────

pub fn urlencoded(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b' ' => result.push('+'),
            _ => {
                result.push('%');
                result.push(HEX_CHARS[(byte >> 4) as usize] as char);
                result.push(HEX_CHARS[(byte & 0x0F) as usize] as char);
            }
        }
    }
    result
}

const HEX_CHARS: &[u8; 16] = b"0123456789ABCDEF";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_urlencoded() {
        assert_eq!(urlencoded("hello world"), "hello+world");
        assert_eq!(urlencoded("rust lang"), "rust+lang");
        assert_eq!(urlencoded("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoded("你好"), "%E4%BD%A0%E5%A5%BD");
    }

    #[test]
    fn test_parse_ddg_results() {
        let html = r#"
        <html><body>
            <div class="result">
                <a class="result__a" href="https://example.com/rust">Rust Programming</a>
                <span class="result__snippet">A language empowering everyone.</span>
                <span class="result__url">example.com</span>
            </div>
            <div class="result result--ad">
                <a class="result__a" href="https://ad.com">Ad link</a>
            </div>
            <div class="result">
                <a class="result__a" href="https://github.com">GitHub</a>
                <span class="result__snippet">Where the world builds software.</span>
            </div>
        </body></html>
        "#;
        let results = parse_ddg_results(html, 5).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Rust Programming");
        assert_eq!(results[0].url, "https://example.com/rust");
        assert_eq!(results[0].snippet, "A language empowering everyone.");
        assert_eq!(results[0].site_name, Some("example.com".to_string()));

        assert_eq!(results[1].title, "GitHub");
        assert_eq!(results[1].url, "https://github.com");
        assert_eq!(results[1].site_name, None);
    }

    #[test]
    fn test_moonshot_search_request_parts() {
        let config = WebSearchServiceConfig {
            base_url: "https://api.example.test/coding/v1/search".into(),
            api_key: Some("sk-test".into()),
            custom_headers: [("X-Trace".to_string(), "t1".to_string())]
                .into_iter()
                .collect(),
        };
        let (url, body, headers) =
            moonshot_search_request_parts(&config, "rust tokio", "sk-test", Some("call-1"));
        assert_eq!(url, "https://api.example.test/coding/v1/search");
        assert_eq!(body, r#"{"text_query":"rust tokio"}"#);
        assert!(headers.contains(&("Authorization".to_string(), "Bearer sk-test".to_string())));
        assert!(headers.contains(&("Content-Type".to_string(), "application/json".to_string())));
        assert!(headers.contains(&("X-Msh-Tool-Call-Id".to_string(), "call-1".to_string())));
        assert!(headers.contains(&("X-Trace".to_string(), "t1".to_string())));
        // No call id (or a blank one) → no header, mirroring v2.
        let (_, _, headers) = moonshot_search_request_parts(&config, "rust tokio", "sk-test", None);
        assert!(!headers.iter().any(|(k, _)| k == "X-Msh-Tool-Call-Id"));
        let (_, _, headers) =
            moonshot_search_request_parts(&config, "rust tokio", "sk-test", Some(""));
        assert!(!headers.iter().any(|(k, _)| k == "X-Msh-Tool-Call-Id"));
    }

    #[test]
    fn test_parse_moonshot_search_response() {
        let body = r#"{"search_results":[
            {"title":"Rust","url":"https://rust.example.test","snippet":"lang","site_name":"rust.example.test","date":"2026-01-01"},
            {"title":"No Site"}
        ]}"#;
        let results = parse_moonshot_search_response(body).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].site_name.as_deref(), Some("rust.example.test"));
        assert_eq!(results[0].date.as_deref(), Some("2026-01-01"));
        assert_eq!(results[0].title, "Rust");
        assert_eq!(results[1].site_name, None);
        assert_eq!(results[1].date, None);
        assert_eq!(results[1].url, "");
        // v2 renders `Date:` between Site and URL.
        let rendered = format_search_results(results);
        assert!(rendered.contains("Date: 2026-01-01\n"));
    }

    #[test]
    fn test_parse_moonshot_search_response_empty_and_invalid() {
        assert!(parse_moonshot_search_response("{}").unwrap().is_empty());
        assert!(
            parse_moonshot_search_response(r#"{"search_results":[]}"#)
                .unwrap()
                .is_empty()
        );
        assert!(parse_moonshot_search_response("not json").is_err());
    }
}

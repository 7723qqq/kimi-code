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

use serde_json::{Value, json};

use super::err_result;
use super::moonshot_service::{self, MoonshotServiceConfig};
use crate::i18n::{LocalizedText, i18n_params};
use crate::native::web_search::{DdgResult, parse_ddg_results, urlencoded};
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

impl From<DdgResult> for WebSearchResultEntry {
    fn from(r: DdgResult) -> Self {
        Self {
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            site_name: r.site_name,
            // The DDG scrape carries no publication date (v2 only maps
            // `date` on the Moonshot provider path).
            date: None,
        }
    }
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
    let json: Value = serde_json::from_str(body).map_err(|e| {
        LocalizedText::fmt(
            "engine.tools.webSearch.invalidJson",
            format!("invalid JSON: {e}"),
            i18n_params!["e" => e],
        )
        .render()
    })?;
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
        output.push_str(
            &LocalizedText::fmt(
                "engine.tools.webSearch.resultTitle",
                format!("Title: {title}\n", title = result.title),
                i18n_params!["title" => result.title],
            )
            .render(),
        );
        if let Some(ref site) = result.site_name {
            output.push_str(
                &LocalizedText::fmt(
                    "engine.tools.webSearch.resultSite",
                    format!("Site: {site}\n"),
                    i18n_params!["site" => site],
                )
                .render(),
            );
        }
        if let Some(ref date) = result.date {
            output.push_str(
                &LocalizedText::fmt(
                    "engine.tools.webSearch.resultDate",
                    format!("Date: {date}\n"),
                    i18n_params!["date" => date],
                )
                .render(),
            );
        }
        output.push_str(
            &LocalizedText::fmt(
                "engine.tools.webSearch.resultUrl",
                format!("URL: {url}\n", url = result.url),
                i18n_params!["url" => result.url],
            )
            .render(),
        );
        output.push_str(
            &LocalizedText::fmt(
                "engine.tools.webSearch.resultSnippet",
                format!("Snippet: {snippet}\n\n", snippet = result.snippet),
                i18n_params!["snippet" => result.snippet],
            )
            .render(),
        );
    }
    output.push_str("When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).");
    output
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
            LocalizedText::plain(
                "engine.tools.webSearch.missingApiKey",
                "Moonshot search service is not configured: missing API key.",
            )
            .render(),
        ));
    };
    let (url, body, headers) = moonshot_search_request_parts(config, query, &api_key, tool_call_id);
    let client = match moonshot_service::build_client() {
        Ok(c) => c,
        Err(e) => {
            return Some(err_result(
                LocalizedText::fmt(
                    "engine.tools.webSearch.clientInitFailed",
                    format!("Search failed: Failed to initialize HTTP client: {e}"),
                    i18n_params!["e" => e],
                )
                .render(),
            ));
        }
    };
    let mut request = client.post(&url).body(body);
    request = moonshot_service::apply_headers(request, headers);
    let response = match request.send().await {
        Ok(resp) => resp,
        Err(e) => {
            let msg = if e.is_timeout() {
                LocalizedText::fmt(
                    "engine.tools.webSearch.timedOut",
                    format!("Search timed out: {e}"),
                    i18n_params!["e" => e],
                )
                .render()
            } else {
                LocalizedText::fmt(
                    "engine.tools.webSearch.networkFailed",
                    format!("Search failed (network): {e}"),
                    i18n_params!["e" => e],
                )
                .render()
            };
            return Some(err_result(msg));
        }
    };
    let status = response.status();
    let text = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return Some(err_result(
                LocalizedText::fmt(
                    "engine.tools.webSearch.readBodyFailed",
                    format!("Search failed: failed to read response body: {e}"),
                    i18n_params!["e" => e],
                )
                .render(),
            ));
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
        return Some(err_result(
            LocalizedText::fmt(
                "engine.tools.webSearch.moonshotHttpFailed",
                format!(
                    "Moonshot search request failed: HTTP {status}{qualifier}. {body}",
                    body = text.trim()
                ),
                i18n_params!["status" => status, "qualifier" => qualifier, "body" => text.trim()],
            )
            .render(),
        ));
    }
    let results = match parse_moonshot_search_response(&text) {
        Ok(r) => r,
        Err(e) => {
            return Some(err_result(
                LocalizedText::fmt(
                    "engine.tools.webSearch.failed",
                    format!("Search failed: {e}"),
                    i18n_params!["e" => e],
                )
                .render(),
            ));
        }
    };
    if results.is_empty() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: "No search results found.".to_string(),
            is_error: false,
            note: None,
            display: None,
        });
    }
    Some(ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: format_search_results(results),
        is_error: false,
        note: None,
        display: None,
    })
}

pub async fn execute_web_search(
    args: &Value,
    tool_call_id: Option<&str>,
) -> Option<ExecutableToolResult> {
    let query = args.get("query")?.as_str()?;
    if query.trim().is_empty() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: LocalizedText::plain(
                "engine.tools.webSearch.emptyQuery",
                "Query parameter cannot be empty",
            )
            .render(),
            is_error: true,
            note: None,
            display: None,
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
                delivery: None,
                stop_turn: false,
                content: LocalizedText::fmt(
                    "engine.tools.webSearch.clientInitFailed",
                    format!("Search failed: Failed to initialize HTTP client: {e}"),
                    i18n_params!["e" => e],
                )
                .render(),
                is_error: true,
                note: None,
                display: None,
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
                LocalizedText::fmt(
                    "engine.tools.webSearch.timedOut",
                    format!("Search timed out: {e}"),
                    i18n_params!["e" => e],
                )
                .render()
            } else {
                LocalizedText::fmt(
                    "engine.tools.webSearch.networkFailed",
                    format!("Search failed (network): {e}"),
                    i18n_params!["e" => e],
                )
                .render()
            };
            return Some(ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: msg,
                is_error: true,
                note: None,
                display: None,
            });
        }
    };

    let status = response.status();
    if !status.is_success() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: LocalizedText::fmt(
                "engine.tools.webSearch.duckduckgoHttpFailed",
                format!("Search failed: DuckDuckGo search returned HTTP {status}"),
                i18n_params!["status" => status],
            )
            .render(),
            is_error: true,
            note: None,
            display: None,
        });
    }

    let body = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return Some(ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: LocalizedText::fmt(
                    "engine.tools.webSearch.readBodyFailed",
                    format!("Search failed: failed to read response body: {e}"),
                    i18n_params!["e" => e],
                )
                .render(),
                is_error: true,
                note: None,
                display: None,
            });
        }
    };

    let results = match parse_ddg_results(&body, MAX_RESULTS).map(|rs| {
        rs.into_iter()
            .map(WebSearchResultEntry::from)
            .collect::<Vec<_>>()
    }) {
        Ok(res) => res,
        Err(e) => {
            return Some(ExecutableToolResult {
                delivery: None,
                stop_turn: false,
                content: LocalizedText::fmt(
                    "engine.tools.webSearch.failed",
                    format!("Search failed: {e}"),
                    i18n_params!["e" => e],
                )
                .render(),
                is_error: true,
                note: None,
                display: None,
            });
        }
    };

    if results.is_empty() {
        return Some(ExecutableToolResult {
            delivery: None,
            stop_turn: false,
            content: "No search results found.".to_string(),
            is_error: false,
            note: None,
            display: None,
        });
    }

    // One renderer for both paths (v2 formats in `webSearchTool`); DDG
    // entries carry no date, so no `Date:` line is emitted for them.
    Some(ExecutableToolResult {
        delivery: None,
        stop_turn: false,
        content: format_search_results(results),
        is_error: false,
        note: None,
        display: None,
    })
}

// ── HTML Parsing ─────────────────────────────────────────────────────────────
//
// The DDG scrape (selectors, ad skip, URL encoding) lives in
// `native::web_search` so the workflow `SearchProvider` and this tool share
// one implementation. This module only maps `DdgResult` into its own entry
// type via `From` above.

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

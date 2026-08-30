//! WebSearch — DuckDuckGo HTML scraping without API keys.
//!
//! Ported for `kimi-agent` (P26 批 2). Posts search queries to DuckDuckGo,
//! parses HTML results with `scraper`, and formats them for the LLM.

use std::time::Duration;

use scraper::{Html, Selector};
use serde_json::Value;

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
}

pub async fn execute_web_search(args: &Value) -> Option<ExecutableToolResult> {
    let query = args.get("query")?.as_str()?;
    if query.trim().is_empty() {
        return Some(ExecutableToolResult {
            content: "Query parameter cannot be empty".to_string(),
            is_error: true,
            note: None,
        });
    }

    let client = match reqwest::Client::builder()
        .user_agent(DDG_USER_AGENT)
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Some(ExecutableToolResult {
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
                content: msg,
                is_error: true,
                note: None,
            });
        }
    };

    let status = response.status();
    if !status.is_success() {
        return Some(ExecutableToolResult {
            content: format!("Search failed: DuckDuckGo search returned HTTP {status}"),
            is_error: true,
            note: None,
        });
    }

    let body = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return Some(ExecutableToolResult {
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
                content: format!("Search failed: {e}"),
                is_error: true,
                note: None,
            });
        }
    };

    if results.is_empty() {
        return Some(ExecutableToolResult {
            content: "No search results found.".to_string(),
            is_error: false,
            note: None,
        });
    }

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
        output.push_str(&format!("URL: {}\n", result.url));
        output.push_str(&format!("Snippet: {}\n\n", result.snippet));
    }

    output.push_str("When you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).");

    Some(ExecutableToolResult {
        content: output,
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
}

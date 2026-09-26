//! WebSearch — Bing HTML scraping without API keys.
//!
//! GETs a search query to `www.bing.com/search`, parses the result page
//! with `scraper`, and extracts titles, URLs, and snippets.
//! Runs on a blocking thread via `tokio::task::spawn_blocking`.

use scraper::{Html, Selector};
use std::time::Duration;

// ── Configuration ────────────────────────────────────────────────────────────

const BING_HTML_URL: &str = "https://www.bing.com/search";
const BING_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_RESULTS: usize = 10;

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WebSearchConfig {
    pub query: String,
    pub timeout_ms: u64,
    pub max_results: usize,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            query: String::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_results: MAX_RESULTS,
        }
    }
}

/// One Bing HTML result. Shared by the workflow `SearchProvider`
/// (this module) and the LLM `WebSearch` tool (`tools/web_search.rs`), so
/// the scraping selectors have a single home.
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub site_name: Option<String>,
    /// Publication date parsed from the snippet's leading date prefix
    /// (`"1 day ago · …"`, `"Apr 16, 2026 · …"`), when present.
    pub date: Option<String>,
}

#[derive(Debug)]
pub struct WebSearchResult {
    pub results: Vec<SearchResult>,
    pub error: Option<String>,
}

// ── Public entry point ───────────────────────────────────────────────────────

/// Chinese Q&A / encyclopedia domains Bing falls back to when it cannot match
/// a query to its web index. For an English technical query, results from these
/// domains are the "hot feed" fallback — irrelevant content that looks like
/// real results. Detecting it lets the tool report failure instead of feeding
/// garbage to the model.
pub fn is_hot_feed_fallback(query: &str, urls: &[String]) -> bool {
    if urls.is_empty() {
        return false;
    }
    // The query must be predominantly English (technical terms).
    let letters = query.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if letters < 5 {
        return false;
    }
    const HOT_FEED_DOMAINS: &[&str] = &[
        "baidu.com",
        "zhihu.com",
        "sogou.com",
        "so.com",
        "csdn.net",
        "juejin.cn",
        "cnblogs.com",
    ];
    let hot_feed = urls
        .iter()
        .filter(|u| HOT_FEED_DOMAINS.iter().any(|d| u.contains(d)))
        .count();
    hot_feed > urls.len() / 2
}

pub fn web_search(config: &WebSearchConfig) -> WebSearchResult {
    match web_search_inner(config) {
        Ok(results) => {
            let urls: Vec<String> = results.iter().map(|r| r.url.clone()).collect();
            if is_hot_feed_fallback(&config.query, &urls) {
                WebSearchResult {
                    results: Vec::new(),
                    error: Some("hot-feed fallback detected".to_string()),
                }
            } else {
                WebSearchResult {
                    results,
                    error: None,
                }
            }
        }
        Err(err) => WebSearchResult {
            results: Vec::new(),
            error: Some(err),
        },
    }
}

fn web_search_inner(config: &WebSearchConfig) -> Result<Vec<SearchResult>, String> {
    let timeout = Duration::from_millis(config.timeout_ms);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .timeout_write(timeout)
        .user_agent(BING_USER_AGENT)
        .build();

    // GET the Bing search page (query in the URL, form-encoded).
    let url = format!(
        "{}?q={}&setlang=en",
        BING_HTML_URL,
        urlencoded(&config.query)
    );
    let response = agent
        .get(&url)
        .set("Accept", "text/html")
        .set("Connection", "keep-alive")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => {
                format!("Bing search returned HTTP {code}")
            }
            ureq::Error::Transport(t) => format!("Network error: {t}"),
        })?;

    // Read response body
    let body = response
        .into_string()
        .map_err(|e| format!("Failed to read response: {e}"))?;

    // Parse HTML and extract results
    parse_bing_results(&body, config.max_results)
}

// ── HTML Parsing ─────────────────────────────────────────────────────────────

pub fn parse_bing_results(html: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);

    let result_sel =
        Selector::parse("li.b_algo").map_err(|_| "Failed to parse selector".to_string())?;
    let title_sel = Selector::parse("h2 a").map_err(|_| "Failed to parse selector".to_string())?;
    let snippet_sel =
        Selector::parse(".b_caption p").map_err(|_| "Failed to parse selector".to_string())?;
    let site_sel =
        Selector::parse(".b_tpcn .tptt").map_err(|_| "Failed to parse selector".to_string())?;

    let mut results = Vec::new();

    for element in document.select(&result_sel) {
        if results.len() >= max_results {
            break;
        }

        // Extract title and URL from the h2 link (title may contain <strong>).
        let title_el = match element.select(&title_sel).next() {
            Some(el) => el,
            None => continue,
        };
        let title: String = title_el.text().collect::<String>().trim().to_string();
        let url = title_el.value().attr("href").unwrap_or("").to_string();

        if title.is_empty() || url.is_empty() {
            continue;
        }

        // Extract snippet
        let snippet = element
            .select(&snippet_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        // Extract site name (thumbnail text; absent when no thumbnail).
        let site_name = element
            .select(&site_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .filter(|s| !s.is_empty());

        // Split a leading date prefix ("1 day ago ·", "Apr 16, 2026 ·") off
        // the snippet so the date field is populated and the snippet is clean.
        let (date, snippet) = split_bing_snippet(&snippet);

        results.push(SearchResult {
            title,
            url,
            snippet,
            site_name,
            date,
        });
    }

    Ok(results)
}

/// Parse DuckDuckGo HTML results (`div.result` containers). DDG carries no
/// publication date, so `date` is always `None`.
pub fn parse_ddg_results(html: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
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

        results.push(SearchResult {
            title,
            url,
            snippet,
            site_name,
            date: None,
        });
    }

    Ok(results)
}

/// Parse Sogou HTML results (`div.vrwrap` containers). Sogou marks up query
/// terms with `<em>`; the direct URL is in a `data-url` attribute when present,
/// otherwise the title link's redirect href is used.
pub fn parse_sogou_results(html: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html);

    let result_sel =
        Selector::parse("div.vrwrap").map_err(|_| "Failed to parse selector".to_string())?;
    let title_sel =
        Selector::parse("h3.vr-title a").map_err(|_| "Failed to parse selector".to_string())?;
    let snippet_sel =
        Selector::parse(".fz-mid.space-txt").map_err(|_| "Failed to parse selector".to_string())?;

    let mut results = Vec::new();

    for element in document.select(&result_sel) {
        if results.len() >= max_results {
            break;
        }

        let title_el = match element.select(&title_sel).next() {
            Some(el) => el,
            None => continue,
        };
        let title: String = title_el.text().collect::<String>().trim().to_string();
        if title.is_empty() {
            continue;
        }

        // Prefer the direct URL from data-url; fall back to the redirect href.
        let url = title_el
            .value()
            .attr("data-url")
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                title_el
                    .value()
                    .attr("href")
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        if url.is_empty() {
            continue;
        }

        let snippet = element
            .select(&snippet_sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        results.push(SearchResult {
            title,
            url,
            snippet,
            site_name: None,
            date: None,
        });
    }

    Ok(results)
}

/// Split a leading date prefix off a Bing snippet. Bing prefixes snippets with
/// the publication date followed by `" · "`: relative (`"1 day ago · …"`) or
/// absolute (`"Apr 16, 2026 · …"`). Returns `(date, rest)`; `date` is `None`
/// when the snippet has no recognizable prefix.
fn split_bing_snippet(snippet: &str) -> (Option<String>, String) {
    const SEP: &str = " · ";
    let Some(sep_at) = snippet.find(SEP) else {
        return (None, snippet.to_string());
    };
    let (prefix, rest) = snippet.split_at(sep_at);
    let rest = &rest[SEP.len()..];
    if is_bing_date_prefix(prefix) {
        return (Some(prefix.to_string()), rest.trim_start().to_string());
    }
    (None, snippet.to_string())
}

/// Whether a snippet prefix is a Bing relative (`"N day ago"`) or absolute
/// (`"Apr 16, 2026"`) date.
fn is_bing_date_prefix(prefix: &str) -> bool {
    // Relative: "<number> <unit> ago" where unit is second/minute/hour/day/
    // week/month/year (singular or plural).
    if let Some(ago_at) = prefix.find(" ago") {
        let lead = &prefix[..ago_at];
        let mut parts = lead.rsplit(' ');
        let Some(unit) = parts.next() else {
            return false;
        };
        let Some(num) = parts.next() else {
            return false;
        };
        let is_unit = matches!(
            unit,
            "second"
                | "seconds"
                | "minute"
                | "minutes"
                | "hour"
                | "hours"
                | "day"
                | "days"
                | "week"
                | "weeks"
                | "month"
                | "months"
                | "year"
                | "years"
        );
        return is_unit && num.chars().all(|c| c.is_ascii_digit()) && !num.is_empty();
    }
    // Absolute: "Mon DD, YYYY" (e.g., "Apr 16, 2026").
    let mut parts = prefix.split(' ');
    let Some(mon) = parts.next() else {
        return false;
    };
    let Some(day) = parts.next() else {
        return false;
    };
    let Some(year) = parts.next() else {
        return false;
    };
    let is_mon = matches!(
        mon,
        "Jan"
            | "Feb"
            | "Mar"
            | "Apr"
            | "May"
            | "Jun"
            | "Jul"
            | "Aug"
            | "Sep"
            | "Oct"
            | "Nov"
            | "Dec"
    );
    let day_ok = day.trim_end_matches(',').len() <= 2
        && day
            .trim_end_matches(',')
            .chars()
            .all(|c| c.is_ascii_digit());
    let year_ok = year.len() == 4 && year.chars().all(|c| c.is_ascii_digit());
    is_mon && day_ok && year_ok && parts.next().is_none()
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

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_urlencoded() {
        assert_eq!(urlencoded("hello world"), "hello+world");
        assert_eq!(urlencoded("rust lang"), "rust+lang");
        assert_eq!(urlencoded("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn test_urlencoded_reserved_and_unicode() {
        // Unreserved characters pass through unchanged.
        assert_eq!(urlencoded("abc-._~XYZ012"), "abc-._~XYZ012");
        // Empty input stays empty.
        assert_eq!(urlencoded(""), "");
        // CJK and emoji are percent-encoded byte-by-byte (uppercase hex).
        assert_eq!(urlencoded("你好"), "%E4%BD%A0%E5%A5%BD");
        assert_eq!(urlencoded("🔥"), "%F0%9F%94%A5");
    }

    #[test]
    fn test_parse_bing_skips_missing_title_or_url() {
        let html = r#"
        <html><body>
            <li class="b_algo">
                <h2><a href="https://ok.com">OK</a></h2>
                <div class="b_caption"><p>S</p></div>
            </li>
            <li class="b_algo">
                <!-- missing title link entirely -->
                <div class="b_caption"><p>No link</p></div>
            </li>
            <li class="b_algo">
                <h2><a href="">Empty href</a></h2>
            </li>
            <li class="b_algo">
                <h2><a href="https://blank.com">   </a></h2>
            </li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "OK");
    }

    #[test]
    fn test_parse_bing_optional_fields() {
        let html = r#"
        <html><body>
            <li class="b_algo">
                <h2><a href="https://no-snippet.com">No Snippet</a></h2>
            </li>
            <li class="b_algo">
                <h2><a href="https://no-site.com">No Site</a></h2>
                <div class="b_caption"><p>Has snippet only</p></div>
            </li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 10).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].snippet, "");
        assert_eq!(results[0].site_name, None);
        assert_eq!(results[1].snippet, "Has snippet only");
        assert_eq!(results[1].site_name, None);
    }

    #[test]
    fn test_parse_bing_html_entities_decoded() {
        let html = r#"
        <html><body>
            <li class="b_algo">
                <h2><a href="https://a.com?x=1&amp;y=2">Rust &amp; Go &lt;3</a></h2>
                <div class="b_caption"><p>a &gt; b &amp;&amp; c &lt; d</p></div>
            </li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Rust & Go <3");
        assert_eq!(results[0].url, "https://a.com?x=1&y=2");
        assert_eq!(results[0].snippet, "a > b && c < d");
    }

    #[test]
    fn test_parse_bing_zero_and_oversized_max() {
        let html = r#"
        <html><body>
            <li class="b_algo"><h2><a href="https://1.com">R1</a></h2></li>
        </body></html>
        "#;
        // max_results = 0 returns nothing; larger than available returns all.
        assert!(parse_bing_results(html, 0).unwrap().is_empty());
        assert_eq!(parse_bing_results(html, 100).unwrap().len(), 1);
    }

    #[test]
    fn test_parse_bing_ignores_unrelated_divs() {
        let html = r#"
        <html><body>
            <li class="b_algo"><h2><a href="https://r.com">Real</a></h2></li>
            <li class="other"><h2><a href="https://f.com">Fake</a></h2></li>
            <li><h2><a href="https://f2.com">Fake2</a></h2></li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Real");
    }

    #[test]
    fn test_parse_bing_results_empty() {
        let html = "<html><body><div>No results</div></body></html>";
        let results = parse_bing_results(html, 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_parse_bing_results_basic() {
        let html = r#"
        <html><body>
            <li class="b_algo">
                <h2><a href="https://example.com">Example Title</a></h2>
                <div class="b_caption"><p>This is a snippet</p></div>
                <div class="b_tpcn"><div class="tptxt"><div class="tptt">example.com</div></div></div>
            </li>
            <li class="b_algo">
                <h2><a href="https://other.com">Other Title</a></h2>
                <div class="b_caption"><p>Other snippet</p></div>
            </li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 10).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Example Title");
        assert_eq!(results[0].url, "https://example.com");
        assert_eq!(results[0].snippet, "This is a snippet");
        assert_eq!(results[0].site_name.as_deref(), Some("example.com"));
        assert_eq!(results[1].title, "Other Title");
    }

    #[test]
    fn test_parse_bing_max_results() {
        let html = r#"
        <html><body>
            <li class="b_algo"><h2><a href="https://1.com">R1</a></h2><div class="b_caption"><p>S1</p></div></li>
            <li class="b_algo"><h2><a href="https://2.com">R2</a></h2><div class="b_caption"><p>S2</p></div></li>
            <li class="b_algo"><h2><a href="https://3.com">R3</a></h2><div class="b_caption"><p>S3</p></div></li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 2).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_parse_bing_extracts_date_prefix() {
        let html = r#"
        <html><body>
            <li class="b_algo">
                <h2><a href="https://a.com">A</a></h2>
                <div class="b_caption"><p>1 day ago · First snippet</p></div>
            </li>
            <li class="b_algo">
                <h2><a href="https://b.com">B</a></h2>
                <div class="b_caption"><p>Apr 16, 2026 · Second snippet</p></div>
            </li>
            <li class="b_algo">
                <h2><a href="https://c.com">C</a></h2>
                <div class="b_caption"><p>No date here</p></div>
            </li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 10).unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].date.as_deref(), Some("1 day ago"));
        assert_eq!(results[0].snippet, "First snippet");
        assert_eq!(results[1].date.as_deref(), Some("Apr 16, 2026"));
        assert_eq!(results[1].snippet, "Second snippet");
        assert_eq!(results[2].date, None);
        assert_eq!(results[2].snippet, "No date here");
    }

    #[test]
    fn test_split_bing_snippet_relative() {
        let (date, snippet) = split_bing_snippet("2 hours ago · Rust is great");
        assert_eq!(date.as_deref(), Some("2 hours ago"));
        assert_eq!(snippet, "Rust is great");
    }

    #[test]
    fn test_split_bing_snippet_absolute() {
        let (date, snippet) = split_bing_snippet("Dec 25, 2025 · Happy holidays");
        assert_eq!(date.as_deref(), Some("Dec 25, 2025"));
        assert_eq!(snippet, "Happy holidays");
    }

    #[test]
    fn test_split_bing_snippet_no_date() {
        let (date, snippet) = split_bing_snippet("Just a snippet");
        assert_eq!(date, None);
        assert_eq!(snippet, "Just a snippet");
    }

    #[test]
    fn test_is_bing_date_prefix() {
        assert!(is_bing_date_prefix("1 day ago"));
        assert!(is_bing_date_prefix("3 weeks ago"));
        assert!(is_bing_date_prefix("Apr 16, 2026"));
        assert!(is_bing_date_prefix("Dec 1, 2025"));
        assert!(!is_bing_date_prefix("not a date"));
        assert!(!is_bing_date_prefix("yesterday"));
        assert!(!is_bing_date_prefix("Apr 2026"));
        assert!(!is_bing_date_prefix(""));
    }

    #[test]
    fn test_is_hot_feed_fallback() {
        // English technical query + Chinese Q&A domains → fallback.
        let urls = vec![
            "https://zhidao.baidu.com/question/1".to_string(),
            "https://zhuanlan.zhihu.com/p/1".to_string(),
            "https://baike.baidu.com/item/x".to_string(),
        ];
        assert!(is_hot_feed_fallback("noUncheckedIndexedAccess", &urls));

        // English query + relevant domains → not a fallback.
        let good = vec![
            "https://realpython.com/async-io-python".to_string(),
            "https://docs.python.org/3/library/asyncio".to_string(),
        ];
        assert!(!is_hot_feed_fallback("python async best practices", &good));

        // Chinese query → never a fallback (legitimate Chinese results).
        assert!(!is_hot_feed_fallback("rust 编程语言", &urls));

        // Empty results → not a fallback.
        assert!(!is_hot_feed_fallback("noUncheckedIndexedAccess", &[]));
    }

    #[test]
    fn test_parse_sogou_results() {
        let html = r#"
        <html><body>
            <div class="vrwrap">
                <h3 class="vr-title"><a href="/link?url=abc" data-url="https://realpython.com/async-io-python">Python's <em>asyncio</em> Walkthrough</a></h3>
                <div class="fz-mid space-txt">Learn how Python asyncio works with async/await.</div>
            </div>
            <div class="vrwrap">
                <h3 class="vr-title"><a href="/link?url=def" data-url="https://docs.python.org/3/library/asyncio">Developing with asyncio</a></h3>
                <div class="fz-mid space-txt">Official Python asyncio documentation.</div>
            </div>
            <div class="vrwrap">
                <h3 class="vr-title"><a href="/link?url=ghi">No data-url here</a></h3>
                <div class="fz-mid space-txt">Fallback to redirect href.</div>
            </div>
        </body></html>
        "#;
        let results = parse_sogou_results(html, 10).unwrap();
        assert_eq!(results.len(), 3);
        // data-url preferred over redirect href.
        assert_eq!(results[0].url, "https://realpython.com/async-io-python");
        assert_eq!(results[0].title, "Python's asyncio Walkthrough");
        assert_eq!(
            results[0].snippet,
            "Learn how Python asyncio works with async/await."
        );
        // Second result.
        assert_eq!(results[1].url, "https://docs.python.org/3/library/asyncio");
        // Third falls back to redirect href.
        assert_eq!(results[2].url, "/link?url=ghi");
    }
}

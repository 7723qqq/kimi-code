/// GitHub REST API transport core.
///
/// Pure, self-contained HTTP layer used by the native GitHub tools. It owns
/// auth (bearer token from the environment), request headers, TLS (via ureq +
/// rustls), `Link`-header pagination, and error normalization. The tool
/// definitions (schemas, endpoint mapping, output formatting) live in
/// TypeScript — this module just performs authenticated requests.
use std::time::Duration;

use serde_json::Value;

const DEFAULT_BASE_URL: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
const USER_AGENT: &str = "kimi-code";
const DEFAULT_ACCEPT: &str = "application/vnd.github+json";
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// Cap auto-pagination so a runaway `per_page` loop can't hang or blow memory.
const MAX_PAGES: usize = 10;

/// Normalized result of a GitHub request. `body` is the raw response text
/// (JSON, or an aggregated JSON array when paginating). `error` is set for
/// missing-token, transport, and non-2xx cases.
pub struct GithubResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub error: Option<String>,
    pub rate_remaining: Option<i64>,
}

impl GithubResponse {
    fn failure(status: u16, body: String, error: String, rate_remaining: Option<i64>) -> Self {
        Self { status, ok: false, body, error: Some(error), rate_remaining }
    }
}

/// Resolve the token from `GITHUB_TOKEN`, then `GH_TOKEN`. Empty values are
/// treated as unset.
pub fn resolve_token() -> Option<String> {
    env_non_empty("GITHUB_TOKEN").or_else(|| env_non_empty("GH_TOKEN"))
}

/// API base URL — `GITHUB_API_URL` (GitHub Enterprise) or the public API.
pub fn base_url() -> String {
    env_non_empty("GITHUB_API_URL").unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

/// Join `base` and `path`. An absolute URL in `path` (e.g. a pagination `next`
/// link) is returned unchanged.
pub fn build_url(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let base = base.trim_end_matches('/');
    if let Some(rest) = path.strip_prefix('/') {
        format!("{}/{}", base, rest)
    } else {
        format!("{}/{}", base, path)
    }
}

/// Extract the `rel="next"` URL from a `Link` header, if present.
pub fn parse_next_link(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let mut segs = part.split(';');
        let url_seg = match segs.next() {
            Some(s) => s.trim(),
            None => continue,
        };
        let url = url_seg.trim_start_matches('<').trim_end_matches('>');
        if url.is_empty() {
            continue;
        }
        for meta in segs {
            let meta = meta.trim();
            if meta == "rel=\"next\"" || meta == "rel=next" {
                return Some(url.to_string());
            }
        }
    }
    None
}

/// Convert a JSON object into a flat list of `(key, value)` query pairs.
/// String/number/bool values are stringified; null is skipped. Returns an
/// error string when `query_json` is present but not a JSON object.
pub fn query_pairs(query_json: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let raw = match query_json {
        Some(s) if !s.trim().is_empty() => s,
        _ => return Ok(Vec::new()),
    };
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid query_json: {e}"))?;
    let obj = match value {
        Value::Object(map) => map,
        _ => return Err("query_json must be a JSON object".to_string()),
    };
    let mut pairs = Vec::with_capacity(obj.len());
    for (key, val) in obj {
        let s = match val {
            Value::String(s) => s,
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Null => continue,
            other => other.to_string(),
        };
        pairs.push((key, s));
    }
    Ok(pairs)
}

fn rate_remaining_of(resp: &ureq::Response) -> Option<i64> {
    resp.header("x-ratelimit-remaining").and_then(|s| s.parse::<i64>().ok())
}

/// Perform an authenticated GitHub request.
///
/// - `query_json` / `body_json` are JSON strings (object / arbitrary) or `None`.
/// - `accept` overrides the `Accept` header (e.g. `application/vnd.github.diff`).
/// - When `paginate` is true and the first response is a JSON array, follow
///   `Link: rel="next"` (capped at `MAX_PAGES`) and return the concatenated
///   array as the body.
pub fn request(
    method: &str,
    path: &str,
    query_json: Option<&str>,
    body_json: Option<&str>,
    paginate: bool,
    accept: Option<&str>,
) -> GithubResponse {
    let token = match resolve_token() {
        Some(t) => t,
        None => {
            return GithubResponse::failure(
                0,
                String::new(),
                "No GitHub token found. Set the GITHUB_TOKEN (or GH_TOKEN) environment variable."
                    .to_string(),
                None,
            );
        }
    };

    let pairs = match query_pairs(query_json) {
        Ok(p) => p,
        Err(e) => return GithubResponse::failure(0, String::new(), e, None),
    };

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build();
    let accept_header = accept.unwrap_or(DEFAULT_ACCEPT);
    let auth = format!("Bearer {}", token);

    let mut url = build_url(&base_url(), path);
    let mut aggregated: Option<Vec<Value>> = None;
    let mut rate_remaining: Option<i64> = None;
    let mut first = true;

    for _ in 0..MAX_PAGES {
        let mut req = agent
            .request(method, &url)
            .set("Authorization", &auth)
            .set("Accept", accept_header)
            .set("X-GitHub-Api-Version", API_VERSION)
            .set("User-Agent", USER_AGENT);
        // The pagination `next` URL already embeds the query string; only apply
        // caller query params to the first request.
        if first {
            for (k, v) in &pairs {
                req = req.query(k, v);
            }
        }
        first = false;

        let call = match body_json {
            Some(body) if !body.trim().is_empty() => {
                req.set("Content-Type", "application/json").send_string(body)
            }
            _ => req.call(),
        };

        let resp = match call {
            Ok(resp) => resp,
            Err(ureq::Error::Status(code, resp)) => {
                let rr = rate_remaining_of(&resp).or(rate_remaining);
                let body = resp.into_string().unwrap_or_default();
                return GithubResponse::failure(
                    code,
                    body,
                    format!("GitHub API error {code}"),
                    rr,
                );
            }
            Err(ureq::Error::Transport(t)) => {
                return GithubResponse::failure(
                    0,
                    String::new(),
                    format!("network error: {t}"),
                    rate_remaining,
                );
            }
        };

        let status = resp.status();
        rate_remaining = rate_remaining_of(&resp).or(rate_remaining);
        let next = resp.header("Link").and_then(parse_next_link);
        let text = resp.into_string().unwrap_or_default();

        if !paginate {
            return GithubResponse { status, ok: true, body: text, error: None, rate_remaining };
        }

        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Array(items)) => {
                aggregated.get_or_insert_with(Vec::new).extend(items);
                match next {
                    Some(next_url) => {
                        url = next_url;
                        continue;
                    }
                    None => break,
                }
            }
            // Not an array — pagination doesn't apply; return the single page.
            _ => {
                return GithubResponse { status, ok: true, body: text, error: None, rate_remaining };
            }
        }
    }

    let items = aggregated.unwrap_or_default();
    let body = serde_json::to_string(&Value::Array(items)).unwrap_or_else(|_| "[]".to_string());
    GithubResponse { status: 200, ok: true, body, error: None, rate_remaining }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_joins_path() {
        assert_eq!(
            build_url("https://api.github.com", "/repos/o/r"),
            "https://api.github.com/repos/o/r"
        );
        assert_eq!(
            build_url("https://api.github.com/", "repos/o/r"),
            "https://api.github.com/repos/o/r"
        );
    }

    #[test]
    fn build_url_passes_absolute_through() {
        let abs = "https://api.github.com/repositories/1/issues?page=2";
        assert_eq!(build_url("https://api.github.com", abs), abs);
    }

    #[test]
    fn parse_next_link_finds_next() {
        let header = "<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=5>; rel=\"last\"";
        assert_eq!(
            parse_next_link(header).as_deref(),
            Some("https://api.github.com/x?page=2")
        );
    }

    #[test]
    fn parse_next_link_none_when_absent() {
        let header = "<https://api.github.com/x?page=5>; rel=\"last\"";
        assert_eq!(parse_next_link(header), None);
    }

    #[test]
    fn query_pairs_stringifies_scalars() {
        let json = r#"{"state":"open","per_page":100,"draft":true,"skip":null}"#;
        let mut pairs = query_pairs(Some(json)).unwrap();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("draft".to_string(), "true".to_string()),
                ("per_page".to_string(), "100".to_string()),
                ("state".to_string(), "open".to_string()),
            ]
        );
    }

    #[test]
    fn query_pairs_empty_for_none_or_blank() {
        assert!(query_pairs(None).unwrap().is_empty());
        assert!(query_pairs(Some("   ")).unwrap().is_empty());
    }

    #[test]
    fn query_pairs_rejects_non_object() {
        assert!(query_pairs(Some("[1,2,3]")).is_err());
        assert!(query_pairs(Some("not json")).is_err());
    }
}

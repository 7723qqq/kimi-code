//! Shared plumbing for the host-resolved `[services.moonshot_*]` backends
//! (v2 `configSection.ts`): one config shape, the process-global install
//! seam, and the bearer-header / client / key helpers. Policy stays in each
//! tool — `WebSearch` calls the Moonshot service *instead of* DuckDuckGo,
//! `FetchURL` tries it *first* with the direct fetch as fallback —
//! everything mechanical lives here.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Timeout for Moonshot service calls (both tools).
const SERVICE_TIMEOUT_SECS: u64 = 30;

/// One host-resolved `[services.moonshot_*]` entry: the endpoint a native
/// web tool calls instead of (or before) its built-in path.
#[derive(Clone, Debug)]
pub struct MoonshotServiceConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub custom_headers: HashMap<String, String>,
}

/// Install (or clear with `None`) a host-resolved backend. Process-global:
/// the entries are resolved from one config file, so the freshest
/// pipeline's value is the session's value. Callers always install —
/// including `None` — so a backend resolved for one pipeline never leaks
/// into a later pipeline that resolves none.
pub fn install(
    slot: &LazyLock<Mutex<Option<MoonshotServiceConfig>>>,
    config: Option<MoonshotServiceConfig>,
) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = config;
}

/// Read back the installed backend, if any.
pub fn current(
    slot: &LazyLock<Mutex<Option<MoonshotServiceConfig>>>,
) -> Option<MoonshotServiceConfig> {
    slot.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// A configured, non-blank API key. Blank means unconfigured: search
/// reports a tool error, fetch treats it as fallback-worthy (see each
/// tool's doc comment for why they differ).
pub fn non_blank_key(api_key: &Option<String>) -> Option<String> {
    api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .map(str::to_string)
}

/// The bearer header set: `Authorization`, then any per-tool extras (e.g.
/// fetch's `Accept`), then `Content-Type`, with custom headers appended
/// last so they win.
pub fn bearer_headers(
    api_key: &str,
    custom_headers: &HashMap<String, String>,
    extra: &[(&str, &str)],
) -> Vec<(String, String)> {
    let mut headers = Vec::with_capacity(2 + extra.len() + custom_headers.len());
    headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
    for (key, value) in extra {
        headers.push((key.to_string(), value.to_string()));
    }
    headers.push(("Content-Type".to_string(), "application/json".to_string()));
    for (key, value) in custom_headers {
        headers.push((key.clone(), value.clone()));
    }
    headers
}

/// One service-scoped HTTP client.
pub fn build_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(SERVICE_TIMEOUT_SECS))
        .build()
}

/// Apply prebuilt headers to a request.
pub fn apply_headers(
    mut request: reqwest::RequestBuilder,
    headers: Vec<(String, String)>,
) -> reqwest::RequestBuilder {
    for (key, value) in headers {
        request = request.header(key, value);
    }
    request
}

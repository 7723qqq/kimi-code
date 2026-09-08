//! MCP OAuth credential plumbing.
//!
//! Ports the on-disk **key derivation** and the **at-rest encryption** from v2
//! `mcpCore/oauth/store.ts` and `app/mcpConfig/oauthStore.ts`.
//!
//! Still missing: the file-backed store wiring, the device-code login flow,
//! single-flight refresh, and the `needs-auth` server status.

pub mod crypto;
pub mod store;

use sha2::{Digest, Sha256};

/// Longest digest prefix kept in a store key (v2 `mcpOAuthStoreKey`).
const DIGEST_LEN: usize = 24;

/// Basename of a server name, with everything outside `[A-Za-z0-9_-]` folded
/// to `_` and underscore runs collapsed. Errors on an empty result or one that
/// starts with `.` — such a name cannot address a credential file
/// (v2 `sanitizeStoreKey`, store.ts:6-14).
pub fn sanitize_store_key(name: &str) -> Result<String, String> {
    let base = std::path::Path::new(name)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut safe = String::with_capacity(base.len());
    let mut previous_underscore = false;
    for ch in base.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch
        } else {
            '_'
        };
        if mapped == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        safe.push(mapped);
    }
    if safe.is_empty() || safe.starts_with('.') {
        return Err(format!("Invalid MCP OAuth store key: \"{name}\""));
    }
    Ok(safe)
}

/// Canonical resource identifier for a server URL: the URL without its
/// fragment, in the `url` crate's normalized serialization (v2
/// `canonicalMcpOAuthResource`, store.ts:16-20).
pub fn canonical_mcp_oauth_resource(server_url: &str) -> Result<String, String> {
    let mut url =
        url::Url::parse(server_url).map_err(|e| format!("Invalid MCP OAuth server url: {e}"))?;
    url.set_fragment(None);
    Ok(url.to_string())
}

/// Credential store key for one server: `<sanitized name>-<sha256 prefix>`,
/// where the digest covers the *raw* name and the canonical resource so two
/// servers sharing a name but not a URL never collide (v2 `mcpOAuthStoreKey`,
/// store.ts:22-30).
pub fn mcp_oauth_store_key(server_name: &str, server_url: &str) -> Result<String, String> {
    let safe_name = sanitize_store_key(server_name)?;
    let resource = canonical_mcp_oauth_resource(server_url)?;
    let mut hasher = Sha256::new();
    hasher.update(server_name.as_bytes());
    hasher.update([0u8]);
    hasher.update(resource.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{safe_name}-{}", &hex[..DIGEST_LEN]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values computed by running the v2 TypeScript implementation
    /// (`sanitizeStoreKey` / `canonicalMcpOAuthResource` / `mcpOAuthStoreKey`)
    /// under Bun.
    #[test]
    fn test_sanitize_store_key_matches_v2() {
        assert_eq!(sanitize_store_key("github").unwrap(), "github");
        assert_eq!(sanitize_store_key("My Server").unwrap(), "My_Server");
        assert_eq!(sanitize_store_key("a/b/c").unwrap(), "c");
        assert_eq!(sanitize_store_key("we!rd@name").unwrap(), "we_rd_name");
        assert_eq!(sanitize_store_key("my__server").unwrap(), "my_server");
        // The leading dot is folded into `_` before the safety check, exactly
        // like v2 (which only rejects a sanitized name that is empty or still
        // starts with a dot).
        assert_eq!(sanitize_store_key(".hidden").unwrap(), "_hidden");

        assert_eq!(
            sanitize_store_key("").unwrap_err(),
            "Invalid MCP OAuth store key: \"\""
        );
    }

    #[test]
    fn test_canonical_resource_matches_v2() {
        assert_eq!(
            canonical_mcp_oauth_resource("https://example.test/mcp#frag").unwrap(),
            "https://example.test/mcp"
        );
        assert_eq!(
            canonical_mcp_oauth_resource("HTTPS://Example.TEST:443/mcp").unwrap(),
            "https://example.test/mcp"
        );
        assert_eq!(
            canonical_mcp_oauth_resource("http://example.test:80/mcp").unwrap(),
            "http://example.test/mcp"
        );
        assert!(canonical_mcp_oauth_resource("not-a-url").is_err());
    }

    #[test]
    fn test_store_key_matches_v2() {
        assert_eq!(
            mcp_oauth_store_key("github", "https://example.test/mcp").unwrap(),
            "github-21497725e95d3c3d04525b33"
        );
        assert_eq!(
            mcp_oauth_store_key("My Server", "https://example.test/mcp#x").unwrap(),
            "My_Server-6ccae2231dc30337fab70fb9"
        );
        // The digest covers the raw name and the canonical resource, so the
        // fragment never changes the key.
        assert_eq!(
            mcp_oauth_store_key("github", "https://example.test/mcp#other").unwrap(),
            mcp_oauth_store_key("github", "https://example.test/mcp").unwrap()
        );
    }
}

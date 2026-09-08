//! MCP tool name sanitization and qualification.
//!
//! Mirrors `packages/agent-core-v2/src/mcpCore/tool-naming.ts`:
//!   - `sanitize_mcp_name_part`: replace non-safe chars with `_`, collapse runs
//!   - `qualify_mcp_tool_name`: build `mcp__<server>__<tool>` with length cap + hash
//!   - `is_mcp_tool_name`: check if a name starts with the MCP prefix
//!
//! Called once per MCP tool registration (10-50 tools per session).
//! The FNV-1a hash is a single tight loop — trivially fast in Rust.

const MCP_NAME_PREFIX: &str = "mcp__";
const MCP_NAME_SEPARATOR: &str = "__";
const MAX_QUALIFIED_LENGTH: usize = 64;

/// Replace any character outside the safe ASCII set with `_`, then collapse
/// any run of `_` into a single underscore.
pub fn sanitize_mcp_name_part(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    let mut prev_underscore = false;
    for &b in part.as_bytes() {
        let safe = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
        if safe {
            if b == b'_' && prev_underscore {
                // Skip consecutive underscores.
                continue;
            }
            out.push(b as char);
            prev_underscore = b == b'_';
        } else {
            if !prev_underscore {
                out.push('_');
                prev_underscore = true;
            }
        }
    }
    out
}

/// Check if a tool name starts with the MCP prefix.
pub fn is_mcp_tool_name(name: &str) -> bool {
    name.starts_with(MCP_NAME_PREFIX)
}

/// Produce the qualified MCP tool name: `mcp__<server>__<tool>`.
/// If the result exceeds 64 chars, a deterministic FNV-1a hash suffix replaces
/// the tail so the prefix structure stays intact.
pub fn qualify_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    let sanitized_server = sanitize_mcp_name_part(server_name);
    let sanitized_tool = sanitize_mcp_name_part(tool_name);
    let full = format!(
        "{}{}{}{}",
        MCP_NAME_PREFIX, sanitized_server, MCP_NAME_SEPARATOR, sanitized_tool
    );

    if full.len() <= MAX_QUALIFIED_LENGTH {
        return full;
    }

    let hash = stable_hash8(&full);
    let keep = MAX_QUALIFIED_LENGTH - hash.len() - 1;
    format!("{}_{}", &full[..keep], hash)
}

/// FNV-1a over the input's code points, formatted exactly like the TS
/// implementation (`tool-naming.ts:19-26`). The TS accumulator is a JS number
/// that only becomes an int32 once an operator touches it, so a non-empty
/// input renders through the signed interpretation (`-<hex>` without zero
/// padding when negative, 8 zero-padded hex digits otherwise) while the empty
/// input keeps the positive offset basis and renders unsigned. Not
/// cryptographic — only used for collision resistance among a handful of tool
/// names within a single server's tool list.
fn stable_hash8(input: &str) -> String {
    let mut bits: u32 = 0x811c_9dc5;
    for ch in input.chars() {
        bits ^= ch as u32;
        bits = bits.wrapping_mul(0x0100_0193);
    }
    if input.is_empty() {
        return format!("{bits:08x}");
    }
    let signed = bits as i32;
    if signed < 0 {
        format!("-{:x}", signed.unsigned_abs())
    } else {
        format!("{signed:08x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_basic() {
        assert_eq!(sanitize_mcp_name_part("hello"), "hello");
        assert_eq!(sanitize_mcp_name_part("my-tool"), "my-tool");
        assert_eq!(sanitize_mcp_name_part("tool_123"), "tool_123");
    }

    #[test]
    fn test_sanitize_special_chars() {
        assert_eq!(sanitize_mcp_name_part("my.tool"), "my_tool");
        assert_eq!(sanitize_mcp_name_part("my tool"), "my_tool");
        assert_eq!(sanitize_mcp_name_part("a@b#c"), "a_b_c");
    }

    #[test]
    fn test_sanitize_collapse_underscores() {
        assert_eq!(sanitize_mcp_name_part("a..b"), "a_b");
        assert_eq!(sanitize_mcp_name_part("a@#b"), "a_b");
        assert_eq!(sanitize_mcp_name_part("a b c"), "a_b_c");
    }

    #[test]
    fn test_sanitize_cjk() {
        assert_eq!(sanitize_mcp_name_part("工具"), "_");
        assert_eq!(sanitize_mcp_name_part("my工具"), "my_");
    }

    /// Ported verbatim from `test/mcpCore/tool-naming.test.ts`
    /// (`sanitizeMcpNamePart` cases), including the leading/trailing
    /// underscores the TS collapse step keeps.
    #[test]
    fn test_sanitize_matches_ts_contract() {
        assert_eq!(sanitize_mcp_name_part("github_v2-alpha"), "github_v2-alpha");
        assert_eq!(sanitize_mcp_name_part("My Search/Tool!"), "My_Search_Tool_");
        assert_eq!(sanitize_mcp_name_part("@scope/pkg.tool"), "_scope_pkg_tool");
        assert_eq!(sanitize_mcp_name_part("my__server"), "my_server");
        assert_eq!(sanitize_mcp_name_part("a   b"), "a_b");
        assert_eq!(sanitize_mcp_name_part("list..__issues"), "list_issues");
    }

    #[test]
    fn test_is_mcp_tool_name() {
        assert!(is_mcp_tool_name("mcp__server__tool"));
        assert!(!is_mcp_tool_name("read"));
        assert!(!is_mcp_tool_name("mcp_tool"));
        assert!(is_mcp_tool_name("mcp__s__t"));
    }

    #[test]
    fn test_qualify_short() {
        let result = qualify_mcp_tool_name("myserver", "mytool");
        assert_eq!(result, "mcp__myserver__mytool");
        assert!(result.len() <= MAX_QUALIFIED_LENGTH);
    }

    /// Ported verbatim from `test/mcpCore/tool-naming.test.ts`
    /// (`qualifyMcpToolName` cases).
    #[test]
    fn test_qualify_matches_ts_contract() {
        assert_eq!(
            qualify_mcp_tool_name("github", "list_issues"),
            "mcp__github__list_issues"
        );
        assert_eq!(
            qualify_mcp_tool_name("My Search", "do.thing"),
            "mcp__My_Search__do_thing"
        );
        // The server / tool boundary stays unambiguous when either half
        // contained `__`.
        assert_eq!(
            qualify_mcp_tool_name("my__server", "foo"),
            "mcp__my_server__foo"
        );
        assert_eq!(
            qualify_mcp_tool_name("gh", "list__issues"),
            "mcp__gh__list_issues"
        );
    }

    /// The exact TS output for the hash-truncated case: the FNV-1a
    /// accumulator is negative, so the suffix is `-<hex>` (9 chars) and the
    /// head is truncated to 54 characters.
    #[test]
    fn test_qualify_long() {
        let long_server = "a".repeat(40);
        let long_tool = "b".repeat(40);
        let result = qualify_mcp_tool_name(&long_server, &long_tool);
        assert_eq!(
            result,
            "mcp__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa__bbbbbbb_-785fd989"
        );
        assert_eq!(result.len(), MAX_QUALIFIED_LENGTH);
        assert!(result.starts_with(MCP_NAME_PREFIX));
    }

    /// Different servers must not collapse onto the same hashed name.
    #[test]
    fn test_qualify_long_differentiates_servers() {
        let tool = "x".repeat(40);
        let from_a = qualify_mcp_tool_name(&"a".repeat(40), &tool);
        let from_b = qualify_mcp_tool_name(&"b".repeat(40), &tool);
        assert_eq!(
            from_a,
            "mcp__aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa__xxxxxxx_-42797fe9"
        );
        assert_eq!(
            from_b,
            "mcp__bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb__xxxxxxx_-7dafadb1"
        );
        assert_ne!(from_a, from_b);
    }

    #[test]
    fn test_qualify_deterministic() {
        let server = "very_long_server_name_that_exceeds_limit";
        let tool = "very_long_tool_name_that_also_exceeds";
        let r1 = qualify_mcp_tool_name(server, tool);
        let r2 = qualify_mcp_tool_name(server, tool);
        assert_eq!(r1, r2, "hash must be deterministic");
    }

    #[test]
    fn test_qualify_sanitizes() {
        let result = qualify_mcp_tool_name("my.server", "my.tool");
        assert_eq!(result, "mcp__my_server__my_tool");
    }

    #[test]
    fn test_hash_format() {
        // FNV-1a of the empty string is the offset basis 0x811c9dc5. TS never
        // applies an int32 operator when there is nothing to hash, so it stays
        // positive and renders unsigned.
        assert_eq!(stable_hash8(""), "811c9dc5");
        // Any real input goes through the signed interpretation.
        assert!(stable_hash8("mcp__a__b").starts_with('-'));
    }
}

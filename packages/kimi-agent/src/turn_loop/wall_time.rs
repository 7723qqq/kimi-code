//! Wall-time headers on persisted tool results and task records, ported from
//! upstream #3966 (`agent-core-v2/src/agent/task/wallTime.ts` and
//! `contextMemory/toolResultRender.ts`).
//!
//! Upstream prepends a `Wall time: X.XXX seconds` line to the tool results
//! the model sees and the journal persists, for a fixed tool set plus every
//! MCP tool; task records and task notifications carry the same line. The
//! duration is measured by the tool scheduler (v2 measures it in the tool
//! executor) and travels with the result.

/// v2 `WALL_TIME_TOOL_NAMES`: the tools whose persisted results carry a
/// wall-time header.
const WALL_TIME_TOOL_NAMES: &[&str] = &[
    "Agent",
    "AgentSwarm",
    "Bash",
    "FetchURL",
    "Glob",
    "Grep",
    "WebSearch",
];

/// v2 `shouldRenderWallTime`: the fixed set plus every MCP tool
/// (`isMcpToolName` — the `mcp__<server>__<tool>` prefix).
pub fn should_render_wall_time(tool_name: &str) -> bool {
    WALL_TIME_TOOL_NAMES.contains(&tool_name) || tool_name.starts_with("mcp__")
}

/// v2 `formatTaskWallTime`: `(ms / 1000).toFixed(3) seconds`.
///
/// Upstream clamps with `Math.max(0, endedAt - startedAt)` because it derives
/// the duration from two wall-clock timestamps, which can skew backwards. The
/// engine has no such pair: callers pass a duration already measured from a
/// monotonic clock (`Instant::elapsed` in the tool scheduler, see
/// `turn_loop::run_turn`), which cannot be negative — hence the `u64` parameter
/// and the absent clamp. Callers computing a difference themselves must clamp
/// before calling this.
pub fn format_wall_time_ms(duration_ms: u64) -> String {
    format!("{:.3} seconds", duration_ms as f64 / 1000.0)
}

/// The header line v2 prepends: `Wall time: X.XXX seconds`.
pub fn wall_time_header(duration_ms: u64) -> String {
    format!("Wall time: {}", format_wall_time_ms(duration_ms))
}

/// v2 `renderToolResultForModel`'s header step: prepend the wall-time line
/// to a tool result's text content.
pub fn prepend_wall_time(content: &str, duration_ms: u64) -> String {
    format!("{}\n{}", wall_time_header(duration_ms), content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_render_wall_time_set_and_mcp() {
        for name in [
            "Agent",
            "AgentSwarm",
            "Bash",
            "FetchURL",
            "Glob",
            "Grep",
            "WebSearch",
        ] {
            assert!(should_render_wall_time(name), "{name}");
        }
        assert!(should_render_wall_time("mcp__github__search"));
        assert!(!should_render_wall_time("Read"));
        assert!(!should_render_wall_time("Write"));
        assert!(!should_render_wall_time("TaskList"));
        assert!(!should_render_wall_time("mcp"));
    }

    #[test]
    fn test_format_wall_time_ms() {
        assert_eq!(format_wall_time_ms(0), "0.000 seconds");
        assert_eq!(format_wall_time_ms(1), "0.001 seconds");
        assert_eq!(format_wall_time_ms(1234), "1.234 seconds");
        assert_eq!(format_wall_time_ms(60_000), "60.000 seconds");
    }

    #[test]
    fn test_prepend_wall_time() {
        assert_eq!(
            prepend_wall_time("output", 1500),
            "Wall time: 1.500 seconds\noutput"
        );
        assert_eq!(prepend_wall_time("", 0), "Wall time: 0.000 seconds\n");
    }
}

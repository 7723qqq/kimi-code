---
"@moonshot-ai/kimi-code": minor
---

Spill oversized tool output to disk instead of dropping it (ported from deepseek-harness `spill`, MIT). `ToolResultTruncator` (`packages/kimi-agent/src/tool_result_truncation.rs`) keeps the head and tail of a truncated tool result, writes the retained bytes to a spill file, and returns a model-facing locator that tells the model to re-read the file with the `Read` tool. Spill files are created lazily (never eagerly) and pruned by age.

The spill directory is fixed at `<workspace>/.kimi/spill`; there is no `[spill] root` config section. `ToolResultTruncator::for_workspace(workspace_root)` derives it, `ToolResultTruncator::new(spill_dir)` takes an explicit directory, and `cleanup_expired_spills(max_age)` bounds workspace growth.

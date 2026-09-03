---
"@moonshot-ai/kimi-code": patch
---

Move the Rust engine's blocking file-I/O tools off tokio async worker threads: `NativeToolset::execute_tool` now runs read/grep/glob/write/edit through `tokio::task::spawn_blocking` (tool bodies refactored into `root: &Path` associated functions; closures carry only owned data). This fixes up to `MAX_PARALLEL_TOOLS=16` concurrent blocking calls monopolizing tokio workers and starving the bash output pump, LLM stream, and steer queue. A `spawn_blocking` `JoinError` is routed by tool mutability: read/grep/glob fall back to the host (idempotent, safe to re-run), while write/edit return an error result so an authorized mutating call can never execute twice. Tool semantics and outputs are otherwise unchanged; benchmarks show no regression (batch Read 46.9→48.4ms, 16-way concurrent batch 3.74→4.21ms, noise level).

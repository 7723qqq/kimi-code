---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
---

Add spill storage for oversized tool output (ported from deepseek-harness `spill`, MIT): a Session-scoped `ISpillService` writes truncated tool results to a private session-scoped artifact (0700 root, safe-name encoding, exclusive writes) and returns a model-facing locator with a Read-tool retrieval hint. `ToolResultBuilder` gained an optional `onTruncated` hook that attaches a `spilled` reference to truncated results, wired into `BashTool` and `FetchURLTool`; hook failures degrade best-effort. Configurable via the new `[spill] root` config section.

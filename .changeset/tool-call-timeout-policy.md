---
'@moonshot-ai/kimi-code': minor
---

Per-call tool execution budgets (ported from deepseek-harness `guard/timeout-policy`, MIT)

- `RunnableToolExecution` gains an optional `timeoutMs`; when a tool declares one, the executor arms a deadline over the execution's abort signal and reports an explicit `Tool "X" timed out after Nms` error result if the budget elapses before the tool settles.
- MCP tools now declare a 60s per-call budget, covering every transport (stdio/SSE clients have no request timeout of their own) — not a reconnect path, because there is none: the engine has no automatic reconnect, and MCP connection recovery is limited to the explicit on-demand `reconnect` / `reconnect_after_current` entry points.
- User cancellation still wins over the deadline; tools without `timeoutMs` are unaffected.

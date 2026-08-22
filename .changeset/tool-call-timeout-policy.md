---
"@moonshot-ai/agent-core-v2": minor
---

Per-call tool execution budgets (ported from deepseek-harness `guard/timeout-policy`, MIT)

- `RunnableToolExecution` gains an optional `timeoutMs`; when a tool declares one, the executor arms a deadline over the execution's abort signal and reports an explicit `Tool "X" timed out after Nms` error result if the budget elapses before the tool settles.
- MCP tools now declare a 60s per-call budget, covering every transport and the reconnect path (stdio/SSE clients have no request timeout of their own).
- User cancellation still wins over the deadline; tools without `timeoutMs` are unaffected.

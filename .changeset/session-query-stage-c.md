---
"@moonshot-ai/kimi-code": minor
---

Add the `session_query` agent tool (stage C of the session-query port, from deepseek-harness `tool-session-query`, MIT): three operations — `session_search` (cross-session full-text search scoped to the caller's workspace cwd with session/event filters), `event_search` (within-session search, current session by default), and `session_trace` (fork lineage). Arguments are validated per operation with ISO 8601 timestamp bounds; results render as model-readable text with snippets and a result cap. Main agent only.

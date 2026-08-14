---
"@moonshot-ai/agent-core-v2": minor
---

Add session-query stage B (ported from deepseek-harness `session-query`, MIT): event-level filtering and full-text search over the wire journal. `ISessionQueryService` gains `filterEvents` (seq/time/type/literal-text predicates), `searchEvents` (exact-token ranking with bounded snippets and opaque cursor paging, using the embedded store's tokenizer), and `searchSessions` (cross-session, live-by-default with session filters to widen). Events are read from the main-agent wire journal through the append-log store and cached per session with revision-keyed invalidation.

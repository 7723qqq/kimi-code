---
"@moonshot-ai/agent-core-v2": minor
---

Add the logical-corpus session query surface (stage A, ported from deepseek-harness `session-query`, MIT): an App-scope `ISessionQueryService` lists sessions with live/persisted availability through the session index and workspace lifecycle registry, applies validated ANDed/ORed filters (id, cwd, created-at, parent, availability), and traces fork lineage through `custom.parent_session_id` into ancestor chains and descendant trees with the upstream complete/unresolved contract. New `session_query.*` error codes.

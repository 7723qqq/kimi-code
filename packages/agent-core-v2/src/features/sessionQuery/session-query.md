Search prior session history: cross-session full-text search over your own workspace's sessions, within-session event search, and fork-lineage tracing.

Operations:
- `session_search`: full-text search across the workspace's sessions. The `query` is a literal phrase; results rank sessions by the strongest matching event and include a bounded snippet. Optional filters narrow the corpus: `session_ids`, `created_at_from`/`created_at_to` (inclusive ISO 8601), `parent_session_ids`, `include_root_sessions`, `availability` (`live`/`persisted`), and event bounds `event_seq_from`/`event_seq_to`/`event_time_from`/`event_time_to`/`event_types`.
- `event_search`: full-text search within one session's events (omit `session_id` for the current session). Same query semantics; optional `seq_from`/`seq_to`/`time_from`/`time_to`/`event_types` bounds.
- `session_trace`: fork lineage of one session (omit `session_id` for the current session) — the ancestor chain and descendant trees.

Queries are interpreted as data, never as query syntax. Results are capped at 20 entries; narrow the query or add filters to find more.

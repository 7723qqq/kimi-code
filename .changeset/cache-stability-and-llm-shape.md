---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-native-tools": patch
---

Cache-correctness and prompt-cache-stability hardening:

- `llmRequester`: run micro-compaction on the raw history **before** `shapeHistory` so the `keepRecentMessages` cutoff (an index into raw history) stays stable and tool results inside the kept tail are not truncated.
- `profile`: freeze the additional-dirs listing in the system-prompt prefix (keyed on the dir list, so `/add-dir` rebuilds immediately) and coalesce overlapping `refreshSystemPrompt` triggers into a single run plus one queued follow-up.
- `client-configs`: re-validate a cached config against the caller's schema on hit; a hit that no longer parses is treated as a miss.
- `byteLruCache`: evict by byte cap even when a cache key grows in place.
- `kimi-native-tools`: TOCTOU-guard the file-read cache by snapshotting `(mtime, size)` before the read and skipping the cache entry if the file changed in between.

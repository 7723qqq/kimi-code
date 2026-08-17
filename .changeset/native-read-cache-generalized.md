---
"@moonshot-ai/kimi-native-tools": patch
---

Read: make the native file-read cache a general read-result cache so it actually engages. The cache is now keyed by the full read request `(path, line_offset, n_lines)` instead of only whole-file reads, and stores the complete `ReadResult`; equivalent requests are normalized to one key (offset 0/1 and `n_lines` at/above the cap collapse to the default full-file view). Previously the cache was dead code — the TypeScript caller always passed explicit `line_offset`/`n_lines`, so the `None`/`None` cache condition never matched and every read hit disk. Now the default read path (and partial reads, and `native_batch_read`) are served from cache, with the existing TOCTOU snapshot guard preserved. Also fixes a cache-key normalization bug where negative (tail) offsets were collapsed to offset 1, which could have served the wrong tail window.

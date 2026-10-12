---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Redownload ripgrep instead of reusing a damaged cached copy. On Windows the extracted `rg.exe` was streamed straight into its final path, so an interrupted install left a truncated binary that every later start accepted as valid and handed to the search tools; the extraction now stages beside the destination and renames into place, and a partially written file can no longer be mistaken for a good one. The cached copy is also required to be executable on macOS and Linux, so a cache that lost its permissions is redownloaded rather than failing later with a format error.

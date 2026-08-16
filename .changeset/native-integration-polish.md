---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Polish the native integration:

- Cache the `/status` native-tools probe for the process lifetime (the previous implementation re-verified every cached native asset — a full read + sha256 per file — on each report).
- Make `BashTool.spawn` async and drop a redundant promise wrapper.
- Update the Grep tool description to reflect that the native Rust engine is the primary path (ripgrep-compatible feature set).

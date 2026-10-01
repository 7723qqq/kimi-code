---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-agent": patch
---

Fix activating a bundled product skill or one from a configured extra skill directory: `/skill:` now finds them, expands their arguments, and reports where each came from. Skills marked reference-only are now refused instead of loaded.
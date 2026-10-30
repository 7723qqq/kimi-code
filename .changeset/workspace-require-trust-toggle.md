---
"@moonshot-ai/kimi-code": patch
---

Add a `[workspace] require_trust` switch, on by default; setting it to `false` skips the startup trust prompt for every workspace and loads project-level MCP servers without confirmation, while existing trust records are kept for when it is turned back on.

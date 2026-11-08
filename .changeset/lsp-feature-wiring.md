---
"@moonshot-ai/kimi-code": patch
---

Enable the LSP tool behind the `lsp` experimental flag. The feature was fully implemented but its module was never imported, so the flag did nothing and an `[lsp]` config section was rejected as unknown.

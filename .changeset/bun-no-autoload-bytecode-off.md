---
"@moonshot-ai/kimi-code": patch
---

Bun single-file binaries no longer autoload `.env`/`bunfig.toml` from the current directory at runtime, and Bun bytecode is no longer embedded by default; set `KIMI_CODE_BUN_ENABLE_BYTECODE=1` to opt back in.

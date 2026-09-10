---
'@moonshot-ai/kimi-code': patch
---

Apply [services.moonshot_search] and [services.moonshot_fetch] (with their KIMI_WEB_* env overrides) to ACP, standalone server and REPL sessions instead of silently falling back to the built-in web tools.

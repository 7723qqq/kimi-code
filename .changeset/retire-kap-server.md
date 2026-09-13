---
"@moonshot-ai/kimi-code": patch
---

Retire the legacy kap-server package: the native kimi-agent engine is now the sole server runtime (`--legacy-server` already rejects with a deprecation error). Removes the package, its workspace wiring, and its dev scripts.

---
"@moonshot-ai/kimi-code": patch
---

Integrate Rust native translation engine into the shared i18n package, with automatic fallback to pure JS when the native module is unavailable. Add createI18n() factory and translateBatch() to the kimi-code i18n module. Deprecate @moonshot-ai/i18n-shared/node.
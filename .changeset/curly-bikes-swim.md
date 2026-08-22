---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/i18n-shared": patch
---

Use the Rust native translation engine in the shared i18n package with automatic fallback to pure JS when the native module is unavailable, and deprecate `@moonshot-ai/i18n-shared/node`.

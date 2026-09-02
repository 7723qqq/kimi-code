---
"@moonshot-ai/kimi-code": patch
---

`/status` now says why a model call went through the host instead of the native transport, and that reason is no longer printed into the terminal on every turn. A Rust engine that keeps crashing now reports itself dead instead of failing every later turn.

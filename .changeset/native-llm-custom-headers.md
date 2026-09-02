---
"@moonshot-ai/kimi-code": patch
---

Headers configured for a provider are now sent when the Rust engine calls that provider directly, so gateway setups that need an extra request header work on the native path.

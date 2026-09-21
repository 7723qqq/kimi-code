---
"@moonshot-ai/kimi-code": patch
---

Fix providers declared with `type = "openai_responses"` being sent Chat Completions requests instead of Responses API requests by the Rust engine.

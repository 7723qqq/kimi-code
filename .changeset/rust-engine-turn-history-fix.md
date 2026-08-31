---
"@moonshot-ai/kimi-code": patch
---

Fix the Rust engine dropping earlier conversation history between steps of a multi-step turn, which made tool results invisible to the model.
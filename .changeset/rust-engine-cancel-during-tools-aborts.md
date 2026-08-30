---
"@moonshot-ai/kimi-code": patch
---

Fix the Rust engine reporting a failed turn when a request is cancelled while tools are running. It now stops the turn cleanly.

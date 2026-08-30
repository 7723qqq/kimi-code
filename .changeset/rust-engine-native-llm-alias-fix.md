---
"@moonshot-ai/kimi-code": patch
---

Fix the Rust engine falling back to the host-proxied model request when the configured model alias differs from the provider's model id. Set `agent.engine = "rust"` to use it.

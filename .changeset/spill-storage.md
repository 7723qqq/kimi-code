---
"@moonshot-ai/kimi-code": minor
---

Spill oversized tool output to a file instead of dropping it: the model gets a locator and re-reads the full result with the `Read` tool. Files land in `<workspace>/.kimi/spill` and are pruned by age.

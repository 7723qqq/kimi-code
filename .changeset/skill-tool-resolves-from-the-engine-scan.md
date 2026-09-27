---
"@moonshot-ai/kimi-code": patch
---

Fix the `Skill` tool resolving skills from the engine's own scan — the same roots and policy the system prompt's skills section uses — instead of failing every call against a host state-bridge domain that was never implemented.

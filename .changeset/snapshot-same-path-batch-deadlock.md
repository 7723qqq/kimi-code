---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix Edit calls stalling in the preparation state when one step edits the same file twice: the recovery snapshot is now captured when the tool actually starts instead of before the whole batch is prepared.

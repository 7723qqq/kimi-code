---
"@moonshot-ai/kimi-code": patch
---

Fix sessions created by older versions vanishing from the session list and failing to open in the web UI, because their state files only record a legacy top-level `cwd` that the startup session-index rebuild did not recognize.

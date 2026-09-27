---
'@moonshot-ai/kimi-code': patch
---

Align three config behaviors: `[loop_control].compaction_max_attempts` now caps the requests one compaction round may issue (default 5), `[secondary_model].default_effort` is validated against every pool model at startup, and a `[models]` entry without a `model` field logs a warning naming the entry.

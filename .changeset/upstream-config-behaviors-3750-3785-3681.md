---
'@moonshot-ai/kimi-code': patch
---

Port three upstream config behaviors into the Rust engine:

- `[loop_control].compaction_max_attempts` caps the total requests one compaction round may issue (default 5, matching upstream #3750). It replaces the summarizer's hardcoded 10-attempt retry budget, so a failing compaction stops sooner instead of re-sending the whole omitted prefix ten times.
- `[secondary_model].default_effort` is now validated against every pool model's declared `capabilities` / `support_efforts` / `adaptive_thinking` and rejected at startup when a model cannot honor it (upstream #3785). `off` is refused for a model that always reasons. The model catalog also reports `adaptive_thinking`.
- A `[models]` entry without a `model` field now logs a warning naming the entry, including the quoted table name to write when an unquoted dotted alias was the cause (upstream #3681).

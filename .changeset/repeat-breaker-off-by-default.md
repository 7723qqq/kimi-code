---
"@moonshot-ai/kimi-code": patch
---

Stop interrupting a turn after repeated identical tool calls by default, and stop it from claiming a limit it cannot observe; set `KIMI_CODE_REPEAT_BREAKER=1` to restore the repeat reminders and the forced stop.

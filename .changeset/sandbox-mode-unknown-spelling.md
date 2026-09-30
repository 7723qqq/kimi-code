---
"@moonshot-ai/kimi-code": patch
---

A misspelled sandbox mode no longer silently turns the sandbox off. It falls back to the most restrictive read-only mode and reports which spellings are accepted, and an unknown value arriving over the run-turn API is rejected outright.
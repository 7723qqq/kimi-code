---
"@moonshot-ai/kimi-code": patch
---

Fix Kimi Code starting twice on every launch. The CLI module ran `main()` when it was imported, and the process entry then called it a second time, so one launch booted two copies: two update prompts stacked in the terminal with flickering text, two shells competing for the screen, and two sets of startup side effects.

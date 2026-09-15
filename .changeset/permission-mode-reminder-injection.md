---
'@moonshot-ai/kimi-code': patch
---

Inject the auto permission-mode reminders into the model context. Entering auto mode now tells the model that approvals are automatic, that `AskUserQuestion` must not be called, and that an auto-approved `ExitPlanMode` is not user consent to start executing; leaving auto mode tells it to expect approval prompts again. The reminders are recovered from the conversation history, so a resumed session does not repeat them, and `KIMI_CODE_PERMISSION_MODE_REMINDER=0` disables the injection.

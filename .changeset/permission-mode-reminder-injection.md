---
'@moonshot-ai/kimi-code': patch
---

Tell the model when permissions are automatic: entering auto mode now says approvals need no interaction, that `AskUserQuestion` must not be called, and that an auto-approved `ExitPlanMode` is not consent to start executing. Set `KIMI_CODE_PERMISSION_MODE_REMINDER=0` to disable the reminders.

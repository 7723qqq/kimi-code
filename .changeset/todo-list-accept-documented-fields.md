---
"@moonshot-ai/kimi-code": patch
---

Fix TodoList rejecting the item fields its own description tells the model to send. Writes carrying `id`, `parentId`, `kind`, or `progress` were rejected outright as unknown parameters, so a list could never keep its milestone hierarchy or progress; those fields, plus `description`, are now accepted and preserved end to end.

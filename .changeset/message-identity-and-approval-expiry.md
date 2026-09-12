---
'@moonshot-ai/kimi-code': patch
---

Give assistant and user messages identities on the server path, completing the message family of the kimi-web vocabulary: each turn announces its prompt (`event.message.created`), a step's first content delta creates the step's assistant message and every further chunk streams as `event.assistant.delta` with a running content index, and `llm.step.end` finalizes it (`event.message.updated`) with text plus one `tool_use` block per requested tool call. Pending approvals now expire after ten minutes — the blocked call is denied and `event.approval.expired` is broadcast — closing the approval family.

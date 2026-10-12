---
"@moonshot-ai/kimi-code": patch
---

Keep ACP-hosted sessions truthful when the client's terminal buffer or a session reload gets in the way. A Bash call that outran the client's 4 MiB terminal buffer used to have its output silently dropped or shifted, and now reports the truncation in the tool result instead. Re-sending `session/load` (or `session/resume`) for a session with a pending approval no longer shows the same prompt twice. When two Bash calls in one batch could match the same client terminal, the most specific command wins, and a genuinely ambiguous match attaches no terminal rather than the wrong one.

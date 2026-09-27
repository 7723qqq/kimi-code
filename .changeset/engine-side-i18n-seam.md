---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-agent': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Localize the engine's permission reasons, the ACP approval button labels and the native file/Bash failure messages, so they follow the host locale instead of staying English. Approval prompts now also say why they are asking — for example `access to sensitive file requires approval: .env` — instead of only naming the tool. An unwired host keeps the previous English behaviour.

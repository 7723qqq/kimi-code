---
'@moonshot-ai/kimi-code': patch
---

Bash commands that cannot be statically analyzed — an unbalanced quote, or a command name that is a variable rather than a literal — now ask for approval in every permission mode except Yolo, matching upstream. Previously they ran without a prompt in all modes.

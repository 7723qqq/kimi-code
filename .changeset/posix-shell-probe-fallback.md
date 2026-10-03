---
"@moonshot-ai/kimi-code": patch
---

On POSIX hosts the Bash tool now resolves its shell the way the reference does — `/bin/bash`,
`/usr/bin/bash`, `/usr/local/bin/bash`, then `/bin/sh` — instead of hardcoding `/bin/bash`.
A host without bash at that path (Alpine, slim containers) got a tool pointing at a program that
does not exist; it now falls back to `sh`. The system prompt follows the shell the tool actually
runs, which is what the Windows side already did.

---
'@moonshot-ai/kimi-code': patch
---

Restore live Bash output for commands that also write to stderr: each stream keeps its own progress window, so a banner on stderr no longer hides the command's real output.

---
"@moonshot-ai/pi-tui": patch
---

Drop a program-status record when the program reports `clear` for it, and empty the record table on `stop()`. Long sessions with many subagents no longer accumulate one cleared record per finished subagent; the root record, the replay-on-support behaviour and the tmux passthrough are unchanged.

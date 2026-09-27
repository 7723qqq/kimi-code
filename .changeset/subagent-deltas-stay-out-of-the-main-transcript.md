---
"@moonshot-ai/kimi-code": patch
---

Stop subagent reasoning and tool calls from being shredded into the main transcript: subagent deltas are now dropped from the main transcript's channels, and their progress is shown by the subagent's own activity row instead.

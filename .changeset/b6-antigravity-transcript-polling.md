---
"@moonshot-ai/kimi-code": patch
---

Stop an Antigravity turn's progress monitor from re-reading the entire transcript file every 100 ms while the agent process runs, and cap the buffered agent error output at the last 64 KiB so a chatty process cannot grow memory until it exits.

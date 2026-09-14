---
"@moonshot-ai/kimi-code": minor
---

Add a persistent memory filesystem: the agent remembers durable facts about you across sessions and files them automatically after each turn. Memory is stored under `~/.kimi-code/memory/`; disable the automatic filing with `KIMI_AGENT_MEMORY_FILING=0` or `[experimental].memory_filing = false`.

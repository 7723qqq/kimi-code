---
"@moonshot-ai/kimi-code": patch
---

Fold finished agents in the Updates panel (Ctrl+N) into a single `+N done` tab. Each subagent used to keep its own tab for the rest of the turn, so a fan-out of short-lived subagents filled the tab strip until it no longer fit the width budget — at which point the panel dropped the strip entirely and `←`/`→` navigation lost its destination list. The agent you are viewing always keeps its own tab, and the entries of folded channels stay reachable.

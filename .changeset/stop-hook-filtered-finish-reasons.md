---
"@moonshot-ai/kimi-code": patch
---

A turn the provider marks as filtered no longer dispatches Stop hooks, so a blocking hook can no longer keep a refused answer running instead of ending the turn.
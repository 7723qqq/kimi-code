---
'@moonshot-ai/kimi-code': patch
---

Skill activations now survive a session resume: the activation origin rides the turn's opening message into the persisted history, so the replayed transcript re-renders the activation card instead of showing only the raw prompt.

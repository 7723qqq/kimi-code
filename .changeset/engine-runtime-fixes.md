---
"@moonshot-ai/kimi-code": patch
---

Five engine fixes: a turn's assistant message is no longer dropped from the history (which used to orphan its tool results and break every later request), a missing or unreadable file now names the path instead of declining the call, `EnterPlanMode` and `ExitPlanMode` agree on where the plan is stored, the workspace `AGENTS.md` reminder is injected once instead of every turn, and the default-approve list covers the todo, plan, media, agent, skill and question tools.

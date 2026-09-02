---
"@moonshot-ai/kimi-code": minor
---

Polish pass over the P51–P58 engine additions: resume lifecycle events now carry the real parent tool-call id (the previous internal convention was never populated, so resume cards lacked attribution), native bash progress events are throttled to one per 50ms to keep chatty commands from flooding the host event line (the model's final result still carries the full output), and the fourteen inline lifecycle-event assemblies collapse into three shared helpers.

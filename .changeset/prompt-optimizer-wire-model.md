---
"@moonshot-ai/kimi-code": patch
---

`bench:prompt` and `bench:prompt:prune` now send the model id the endpoint knows. Every configured provider labels a model with an alias (`MiniMax Token Plan/MiniMax-M3.1-Flash`) whose `[models."<alias>"]` entry names the wire id (`MiniMax-M3.1-Flash`); the optimizer sent the alias, so a real run failed on its first call with `unknown model`. The alias still names the report.

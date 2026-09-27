---
'@moonshot-ai/kimi-code': patch
---

Import a models.dev-shaped private registry as configured providers: a new import endpoint takes an `api.json` URL plus an optional Bearer key, writes every listed provider, and re-importing the same URL removes providers that disappeared upstream. Scheduled refreshes rediscover these registries and try each configured key.

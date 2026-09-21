---
'@moonshot-ai/kimi-code': patch
---

Import a models.dev-shaped private registry as configured providers: POST /providers:import_catalog's sibling POST /providers:import_registry takes an api.json URL plus an optional Bearer key, writes every listed provider with a source record, and re-importing the same URL removes providers that disappeared upstream. Scheduled provider refreshes now rediscover those registries, trying each configured key until one answers.

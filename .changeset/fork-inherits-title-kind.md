---
'@moonshot-ai/kimi-code': patch
---

Forked sessions keep their title instead of having it overwritten: a fork created without an explicit title now takes the `Fork: <source title>` default and inherits the source session's title kind, so a custom-titled session's fork is no longer replaced by the first prompt or an auto-generated title.

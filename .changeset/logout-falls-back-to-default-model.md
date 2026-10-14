---
'@moonshot-ai/kimi-code': patch
---

After a logout removes the provider the active model came from, switch the session to the configured default model instead of leaving it on a model that no longer exists.

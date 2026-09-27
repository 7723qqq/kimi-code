---
"@moonshot-ai/kimi-code": patch
---

Roll back the workspace trust-boundary hardening to follow upstream: once you trust a repository, content inside it is your own responsibility, so the project-local config applies without trust gating and the file tools stop re-resolving read and write targets through symlinks. Only the pre-trust window stays guarded.

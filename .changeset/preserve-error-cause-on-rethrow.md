---
"@moonshot-ai/kimi-code": patch
---

Preserve the original error via the `cause` option when re-throwing wrapped errors (kimi-datasource credential load / request timeout, kimi-inspect probe, and the hardcoded-string scanner) so the root cause is retained in the error chain for debugging.

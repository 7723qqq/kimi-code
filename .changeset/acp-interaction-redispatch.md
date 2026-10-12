---
"@moonshot-ai/kimi-code": patch
---

Retry an approval or question prompt when the engine rejects the first response, so a single transient failure no longer leaves the request stuck until the session ends. After two failed attempts the prompt is left pending and reported once instead of being retried forever.

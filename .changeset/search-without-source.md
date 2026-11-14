---
"@moonshot-ai/kimi-code": patch
---

Remove the `source` field from `POST /api/v1/search` responses, and stop serving queries for live sessions from a separate live transcript source: search now always answers from the index.

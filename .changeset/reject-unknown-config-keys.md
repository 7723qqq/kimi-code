---
"@moonshot-ai/kimi-code": patch
---

Reject an unrecognized key in a configuration request instead of silently dropping it: a misspelled field on `POST /api/v1/config`, `POST /api/v1/sessions/{id}/profile`, or any other request body used to come back as `code: 0` with the value quietly discarded. A client that sends a wrong field now gets `40001` naming the key. Every configuration key the server reports on `GET /api/v1/config` is now also writable through `POST /api/v1/config`; sixteen of them (`mcp`, `image`, `model_catalog`, `read`, `github`, `swarm`, `cron`, `task`, `database`, `watch`, …) previously could not be sent at all and were reported as unknown.

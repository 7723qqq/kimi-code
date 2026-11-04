---
"@moonshot-ai/kimi-code": patch
---

Add source folders to workspaces: `POST /api/v1/workspaces` accepts `additional_dirs` and `idempotency_key`, workspace objects report `kind` and `additional_dirs`, and a repeated source folder is rejected with `40006`.

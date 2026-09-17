---
'@moonshot-ai/kimi-code': patch
---

The Web UI's backend badge now reports `rust` for the native server instead of falling back to `v1`. `/api/v1/meta` has always answered `backend: "rust"`, but the client only recognised `"v2"` and normalised every other value to `"v1"`, so the dev-only backend pill and the Settings → Backend row mislabelled the native engine. The `backend` field's declared type now accepts `"rust"` alongside `"v1"` / `"v2"`.

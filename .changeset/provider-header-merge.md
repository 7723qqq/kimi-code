---
'@moonshot-ai/kimi-code': patch
---

Merge `kimi provider update --custom-header` and `--env` entries into the stored records instead of replacing them, so naming one header no longer drops every stored one. Pass `--clear-custom-headers` or `--clear-env` alongside the value flags to replace a record.

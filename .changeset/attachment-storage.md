---
"@moonshot-ai/agent-core-v2": minor
---

Add content-addressed attachment storage (ported from deepseek-harness `attachment`, MIT): an App-scope `IAttachmentService` durably commits images under `sha256:<hex>` content addresses (identical payloads deduplicate, references verify against the named object), with admission policy — declared media type must match the bytes, byte and decoded-pixel limits, and a full raster decode — using kimi's existing magic-byte/dimension sniffing and jimp. Configurable via the `[attachment] root` and `limits` config section; default root is a private per-process temp directory.

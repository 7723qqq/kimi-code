---
"@moonshot-ai/kimi-code": patch
---

Keep built-in URL-fetch SSRF guard semantics identical across Node and Bun runtimes by defaulting to the bundled undici fetch, whose pinned-DNS dispatcher option Bun's global fetch silently ignores.

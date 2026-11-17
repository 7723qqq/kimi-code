---
"@moonshot-ai/kimi-code": patch
---

Read GitHub results in a usable form: lists and searches return one compact line per item instead of a blob that had to be spilled to a file, file contents come back as text instead of base64, an oversized diff truncates instead of failing the call, and a nearly exhausted rate limit is called out.

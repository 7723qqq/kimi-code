---
'@moonshot-ai/kimi-code': patch
---

Session ids are validated as a single path segment in every RPC that resolves them against the sessions root, so a client-supplied id like `../outside` can no longer read, write or delete outside it.

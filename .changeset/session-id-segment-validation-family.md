---
'@moonshot-ai/kimi-code': patch
---

Session ids are now validated as a single path segment in every RPC that resolves them against the sessions root (create, resume, rename, delete — export was covered earlier), so a client-supplied id like `../outside` can no longer read, write, or recursively delete directories outside the sessions root.

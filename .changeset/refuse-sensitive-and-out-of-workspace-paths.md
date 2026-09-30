---
"@moonshot-ai/kimi-code": patch
---

Reading, writing or editing a `.env` file, an SSH private key or a credential store now fails with an explicit reason instead of returning the file, and a relative path that resolves outside the working directory is rejected. Search tools still cover those paths but leave the secrets out of their results.
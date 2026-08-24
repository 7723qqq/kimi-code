---
"@moonshot-ai/kimi-code": patch
---

Ship node-pty's PTY bindings through the packaged-build asset pipelines and preserve executable modes during extraction, so host terminal sessions work in single-file builds on every platform (the release smoke now dlopens the binding).

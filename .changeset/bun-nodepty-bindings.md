---
"@moonshot-ai/kimi-code": patch
---

Ship node-pty with its PTY bindings through the packaged-build asset pipeline and load it from the extracted cache in single-file builds on both engines; the release smoke now dlopens the binding.

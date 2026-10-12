---
"@moonshot-ai/kaos": patch
---

`SSHKaos.close()` is now idempotent and bounded: closing an instance whose connection already dropped returns immediately instead of waiting for a `close` event that has already fired, and a client that never reports the close is destroyed after 5 s so shutdown cannot hang.

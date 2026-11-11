---
"@moonshot-ai/pi-tui": patch
---

Reuse the wrapped lines of unchanged Markdown tokens while text streams, so each update only re-lexes and re-wraps the tail rather than the whole message.

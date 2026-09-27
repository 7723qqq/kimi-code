---
'@moonshot-ai/kimi-code': patch
---

Fix TUI freezes during long assistant streams: while streaming only a bounded tail is rendered, and the full text renders once the turn's assistant stream finishes.

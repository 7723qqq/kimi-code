---
'@moonshot-ai/kimi-code': patch
---

Fix TUI freezes during long assistant streams in normal (non-swarm) mode. The transient streaming renderer re-lexed and re-wrapped the whole ever-growing draft on the main thread every flush (O(n²)), blocking input (ESC/Ctrl+C) and rendering until the stream ended. While streaming, only a bounded tail is now rendered; the full text renders once the turn's assistant stream finishes.

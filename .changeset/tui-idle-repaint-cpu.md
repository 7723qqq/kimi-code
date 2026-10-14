---
'@moonshot-ai/kimi-code': patch
---

Fix high idle CPU use in the terminal UI: animations repaint less often, a tick that would draw the same frame repaints nothing, and a frame that changes nothing no longer keeps the renderer running.

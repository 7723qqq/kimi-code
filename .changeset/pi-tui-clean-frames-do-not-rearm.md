---
'@moonshot-ai/pi-tui': patch
---

Stop the render coalescer re-arming after frames that produced no output, so a request raised by a render pass can no longer chain 62.5 Hz frames on a static screen. Renderers report output through `markFrameOutput()`; a no-output frame answers the request it raised at most once more before dropping it.

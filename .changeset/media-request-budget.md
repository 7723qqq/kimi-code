---
"@moonshot-ai/kimi-code": patch
---

Send images and video by reference instead of inline bytes: media a model cannot accept becomes a file reference the model can re-read, and when accumulated media exceed the request budget the oldest are dropped with a warning instead of failing the turn.

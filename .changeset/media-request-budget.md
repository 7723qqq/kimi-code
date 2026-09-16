---
"@moonshot-ai/kimi-code": patch
---

Media now travels to the engine as a reference to the daemon file store instead of inline base64, and is resolved per request against the model that will receive it. Two consequences are visible: an image or video the model cannot take becomes a `<image path="…">` tag naming the saved file (so the model can re-read it) rather than a payload the provider would reject, and a provider that takes media by reference — the OAuth-managed Kimi providers — receives an `ms://` upload instead of the bytes. When accumulated images and videos exceed the request size budget, the oldest media are omitted from requests with a warning instead of failing; an omitted file leaves its saved path behind, and the omission sticks for the rest of the session.

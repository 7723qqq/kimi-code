---
"@moonshot-ai/kimi-code": patch
---

Fix the Windows desktop launcher so it validates the committed `dist-web` bundle, no longer references the missing `copy-web-assets.mjs` helper, and fails with a clear message when the desktop shell source is not vendored in the checkout. Make package `clean` scripts cross-platform with a Node one-liner, short-circuit the native-module loader hook for non-`.node` requests, and update Windows shell documentation to match the PowerShell-first shell detection.

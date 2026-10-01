---
"@moonshot-ai/kimi-agent": patch
---

A plugin can no longer point its skill directory outside itself: a manifest path that escapes the plugin folder is refused and reported, and an absolute path is no longer accepted.

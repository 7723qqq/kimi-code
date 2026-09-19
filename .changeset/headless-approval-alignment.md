---
"@moonshot-ai/kimi-code": patch
---

Align headless (`kimi -p`) runs with upstream: dangerous commands no longer pause for an approval prompt, and pending approvals expire after 24 hours with `expires_at` surfaced on the wire.

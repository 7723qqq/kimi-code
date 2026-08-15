---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Make file writes crash-safe by writing through a temporary file and renaming into place, so an interrupted write cannot leave a truncated file. Symlink targets are still written through in-place to preserve the link.

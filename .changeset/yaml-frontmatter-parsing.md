---
"@moonshot-ai/kimi-code": patch
---

Fix skill frontmatter being misread: folded multi-line descriptions, block-list `scopes`, inline comments and nested fields now parse as written instead of being dropped or turned into stray values.
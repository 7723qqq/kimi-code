---
"@moonshot-ai/kimi-code": minor
---

Refuse writing or editing through a symlink that resolves outside the workspace, which previously reached the target while the tool reported an in-workspace path. Writing to the real path, or to a directory added to the workspace, still works.

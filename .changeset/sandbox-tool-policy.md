---
"@moonshot-ai/kimi-code": minor
---

Enforce the `[sandbox]` config section: `mode = "read-only"` refuses tools that mutate state, and `mode = "workspace-write"` confines tool file writes to the workspace; shell commands and `run_code` are refused in both modes because they cannot be confined without an OS sandbox backend.

---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
---

Write a spec before implementing: `/spec` (or the `EnterSpecMode` tool) opens spec mode, where the agent writes three documents — requirements, design and tasks — into `specs/<slug>/` **inside your repository**, so they are committed with the code and read again by later sessions. Writes outside that directory are rejected until you approve the spec through `ExitSpecMode`, which presents all three for approval.

This differs from plan mode in what it leaves behind: a plan is a per-session scratch file that becomes a todo list and is then discarded, while a spec is a repository artifact. It is also stricter — spec mode refuses a spec whose documents are missing or empty, and it reads back a `getSpec()` snapshot so a resumed session shows the mode.

The capability is behind the `spec_mode` experimental flag (off by default), toggled in `/settings` → Experiments, and reachable outside the TUI through `session.getSpec()` / `session.setSpecMode()` and the `spec` key on the session status. It is off by default because the prompts that drive document quality are still being tuned.

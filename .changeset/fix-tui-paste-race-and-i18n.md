---
"@moonshot-ai/kimi-code": patch
---

Fix a TUI paste-input race: pi-tui dispatches keystrokes synchronously and never awaits the async clipboard-image handler, so the text-paste fallback could insert at a cursor the user had already moved right after Ctrl-V/Alt-V. The fallback now verifies the editor text/cursor are still untouched before inserting and drops the stale insertion otherwise. Also guards the ExitPlanMode plan-info write against a reset tool UI while `getPlan()` is in flight.

Completes the remaining i18n gaps spotted in the TUI during review: MCP `removed` status, plugin `installing…`/third-party hint, shell-mode badge, task "already terminal" flash, task Model:/Effort: labels, workflow-panel `+N more`/agent count, and approval-panel background-task line are now localized (en/zh).
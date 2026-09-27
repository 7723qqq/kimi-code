---
"@moonshot-ai/kimi-code": patch
---

Fix grep content-mode output duplicating overlapping context lines: when two matches fall closer together than the combined before/after context window, the shared lines are now emitted once.

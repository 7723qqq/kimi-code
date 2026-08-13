---
"@moonshot-ai/kimi-native-tools": patch
---

Fix grep content-mode output duplicating overlapping context lines. When two matches fall closer together than the combined before/after context window, the shared lines between them are now emitted only once — mirroring the single-file path and ripgrep's context-merge behavior.

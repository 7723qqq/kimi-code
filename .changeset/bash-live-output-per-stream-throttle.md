---
'@moonshot-ai/kimi-code': patch
---

Restore live Bash output for commands that also write to stderr. The progress events that drive the live tool card were gated by one shared interval, so whichever stream wrote first consumed the window and the other stream's output was dropped from the live view for the rest of the command — a single banner on stderr was enough to hide the command's real output while it ran. Each stream now keeps its own window, and the first chunk of each is always shown.

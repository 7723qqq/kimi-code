---
'@moonshot-ai/kimi-code': patch
---

`kimi export` now finds sessions persisted by earlier processes (it resolved only live in-memory sessions), and `--include-global-log` actually bundles the global diagnostic log, which the export path now writes to.

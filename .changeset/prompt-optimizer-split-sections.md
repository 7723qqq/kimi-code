---
"@moonshot-ai/kimi-code": patch
---

`bench:prompt:prune` now scans the whole prompt. Since the prompt became a skeleton plus `coding.md`, `delivering-work.md` and `project-information.md`, pruning `system.md` alone reported almost nothing removable while the section files carried hundreds of tokens. The report names the file each section came from, and `--read-only` scans the variant a read-only profile receives (`delivering-work-read-only.md`, no `coding.md`).

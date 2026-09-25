---
"@moonshot-ai/kimi-code": patch
---

Add the missing built-in skills `/sub-skill`, `/sub-skill.review`, `/sub-skill.consolidate` and `/import-from-cc-codex` (ported verbatim from the upstream catalog), and discover nested skills under a parent whose frontmatter sets `has-sub-skill: true` — the children are offered as dotted commands like `/parent.child` and stay out of the model's skill list, the parent is what the prompt advertises. The slash panel now lists built-in skills at all: it used to be built from a host-side filesystem scan that never contained them, while the system prompt already advertised them.

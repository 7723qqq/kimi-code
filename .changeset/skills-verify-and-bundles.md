---
"@moonshot-ai/kimi-code": minor
---

Give skills a way to prove they worked and a way to bundle: a `verify` frontmatter entry appends the commands that must pass before the work is reported, `[skills] subSkills` collapses a family of skills behind one entry point while keeping them invocable, and `[skills] hiddenFromModel` now accepts `*` on either side of a pattern. A `scripts/skills-audit.ts` reports what the library actually costs the prompt.

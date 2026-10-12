---
"@moonshot-ai/kaos": patch
---

Glob patterns can now match a literal `*` or `?`: an escaped wildcard (`a\*`) was emitted into the regex unescaped, so it matched `aaa` (or threw `SyntaxError: nothing to repeat` as a bare `\*`) instead of the file actually named `a*`.

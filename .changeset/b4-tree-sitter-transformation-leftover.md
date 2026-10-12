---
"@moonshot-ai/tree-sitter-bash": patch
"@moonshot-ai/kimi-code": patch
---

Stop silently dropping the tail of a malformed `${v@X}` transformation expansion.

`${x@UQ}` only consumed the `@` and the first letter; the remaining bytes (`Q`, the closing `}`) were left for an exit that never flagged anything, so the tree ended mid-expansion with `hasError: false` and no node covering them. A `${x@Q$(echo hi)}` lost its tail entirely — the `$(…)` never became a `command_substitution`, and no consumer could tell the tree was incomplete. bash rejects both forms as bad substitutions.

The leftover bytes are now covered by a single `ERROR` node inside the `expansion` and `hasError` is set, the same guard the expression engine already applies (`exprLeftover`). Well-formed `${v@Q}` is unchanged and still matches the reference byte-for-byte.

The error flag means a command containing such a form now reaches the dangerous-command analyser as `unanalyzable` (an approval prompt) instead of being analysed as a plain command — the intended direction: an incomplete tree should be visible, not silently trusted.

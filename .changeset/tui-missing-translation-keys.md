---
"@moonshot-ai/kimi-code": patch
---

Fix TUI strings that rendered as raw translation keys, and check for this class of bug in CI.

Twenty `t()` calls in `apps/kimi-code/src` named keys that do not resolve. The Rust engine returns the
key itself when both the locale and the English fallback miss, so the prompt-optimizer panel showed
`tui.promptOptimize.title` above its accept/discard choices, and the MSYS2 install prompt showed
`tui.msys2Prompt.title` with both of its option labels in the same state.

Sixteen of them were one namespace level off: every dialog that mounts over the editor lives under
`tui.dialogs.*`, and these call sites omitted the `dialogs.` segment. The sub-agent phase chip's
failure label asked for a `failed` key that never existed; it now reads the `phaseFailed` label its
sibling phases already use. `/spec`'s description in the command list was missing from both locale
files and is now present in English and Chinese.

`scripts/check-t-call-coverage.mjs` now checks `apps/kimi-code/src` against the app's own locale file
instead of only the packages it used to scan, and runs as a CI step, so a key that resolves to nothing
fails the build instead of reaching users.

---
"@moonshot-ai/kimi-code": patch
---

The prompt rewrite shows that it is working, and its preview no longer hides the end of long lines.

- `tui`: the editor border turns into an in-flight signal while a rewrite is outstanding — a distinct colour plus a `rewriting prompt…` label on the top border. The controller previously set a private `inFlight` flag for re-entrancy and touched nothing in the UI, so the editor sat unchanged across a full model round-trip and read as a frozen screen. The signal is cleared as soon as the model returns, before the accept/discard panel opens, because the wait is what it describes and the review step is not part of it.
- `tui`: the flag lives on `CustomEditor` rather than being applied through `borderColor`. Typing during a rewrite runs the host's border-highlight update, which reassigns `borderColor`; a colour set from outside would have been wiped mid-request while the request was still running.
- `tui`: the preview folds long lines instead of truncating them. Each diff row was passed through `truncateToWidth`, so anything past the right edge — model rewrites routinely produce long prose lines — was dropped without a hint. Rows now wrap at the panel width, with continuation rows indented to the code column so a folded line still reads as one entry. The fold is capped, and reaching the cap is reported rather than silently applied, so the accept/discard choices stay reachable.
- `tui`: the panel's title and hint rows are width-clamped too. They are fixed strings in both locales, so at a narrow terminal the hint used to overflow the panel edge.

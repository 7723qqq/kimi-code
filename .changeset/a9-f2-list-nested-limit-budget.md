---
"@moonshot-ai/agent-core-v2": patch
---

Make `fs.list`'s `limit` bound the nested `children_by_path` entries too, and report `truncated` honestly (a9/F2 of the 2026-10-12 audit).

`WorkspaceFsService.list` treated `limit` as a ceiling on the top-level `items` array only. The guard that enforced it (`items.length >= req.limit && entry.depthRemaining === req.depth`) can only ever fire on the root level, because `entry.depthRemaining === req.depth` is false for every queued child. Each nested directory still pushed every one of its children into `children_by_path`, so a `depth: 10` call over a large tree returned a payload bounded only by the size of the tree — and `truncated` stayed `false`, telling the caller the result was complete. `listMany` inherited the same problem: its `truncated_paths` is derived from `sub.truncated`, so it was always empty.

- A single budget is now shared across all nested levels: `limit` caps the top-level `items` as before, and separately caps the total number of `children_by_path` entries. When either budget is exhausted the walk sets `truncated = true` and stops enqueuing more subdirectories.
- `limit` is the budget for one response, not a per-directory ceiling. A `depth > 1` call can now return fewer children for a given directory than that directory actually has; the `truncated: true` flag is the signal for that, and it is now truthful.
- `items` keeps its existing meaning and priority — top-level entries are the primary content and are filled first. No response field or SDK type changed; `fsListResponseSchema` still has only `items`/`children_by_path`/`truncated`.

If a caller genuinely needs every child of a specific directory, it can still call `fs.list` per directory with `depth: 1` (each call gets its own budget) or narrow `path` so the budget is spent where it matters. `limit` still accepts up to 1000.

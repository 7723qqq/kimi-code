---
"@moonshot-ai/agent-core-v2": minor
---

Make TodoList work for the model, not just the user:

- Persist `progress` and `description` on write so leaf-progress reporting and richer context survive across turns.
- Add an `updates` parameter for incremental patches by id (status / progress / title / description / parentId / kind) — cheaper than rewriting the whole list, so small step-level changes don't feel like busywork.
- Emit a one-line digest of the active todo list as a turn-head reference injection (when the tool is active and at least one item is `in_progress`), so the model plans the next step against its own tracking.
- Restore the stale reminder's appended view to the tree form used by the tool and compaction, eliminating a third formatting variant.
- Undo now re-emits on progress/description/kind/parentId changes too, so the panel and any external observers stay in sync.
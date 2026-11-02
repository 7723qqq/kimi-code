---
"@moonshot-ai/kimi-code": patch
---

Fix undo failing with an event dispatch cycle error in sessions with a long history. After undo or session restore, `todo.updated` is now published once with the final list instead of once per replayed history record; consumers only take the latest state, so this stays backward compatible.

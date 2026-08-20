Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them
- After receiving new multi-step instructions, capture the requirements as todos
- Before starting a tracked task, mark exactly one item as `in_progress`
- Immediately after finishing a tracked task, mark it `done`; do not batch completions at the end

**When NOT to use:**
- Single-shot answers that complete in one or two tool calls
- Trivial requests where tracking adds no clarity
- Purely conversational or informational replies

**Granularity — split to the smallest verifiable unit:**
- A leaf task must be one minimal, independently verifiable unit: read one file, change one function, run one command.
- If finishing an item takes several distinct tool calls, split it further before starting it.
- Splitting is not busywork: a fine-grained list is your working reference — each turn starts with a digest of the items you are tracking, so the granularity you record is the granularity you plan against. Finer items also make progress reportable (see below), which is how you signal and verify forward motion.

**Milestone structure (tiered):**
- Work of 3 steps or fewer: a flat list of fine-grained tasks, no milestones.
- Work of 4 steps or more: first lay out a milestone skeleton — the first milestone is the starting point (confirm context / environment), 1..n middle milestones are coherent phases, the last milestone is the finish line (verify / wrap up) — then attach fine-grained leaf tasks under each milestone.
- Milestones use `kind: "milestone"` with `parentId: null`; leaf tasks reference their milestone via `parentId`. The full list stays a flat array with parent links.

**Progress reporting:**
- On every meaningful update of an `in_progress` leaf task, include its `progress` (0-100). It is persisted and rendered — it is the signal your work is advancing.
- Never set `progress` on milestones — it is computed from their children automatically.
- `done` implies 100; omit `progress` on done items.

**Keep updates cheap:**
- For small changes — marking one item done, bumping a progress percent, reordering a status — prefer `updates: [{ id, ... }]` over rewriting the whole list. Only the fields you pass change; unknown ids are an error naming the current ids.
- Use `todos` only when the structure itself changes (add/remove items, re-tier milestones).

**Avoid churn:**
- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.
- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- Call with `updates: [{ id, status?, progress?, title?, description?, parentId?, kind? }]` to patch existing items in place — the cheap path for daily progress.
- Call with `todos: [...]` to replace the full list (when structure changes). Each item has `title`, `status`, and optionally `id`, `parentId`, `kind`, `progress`, `description`.
- Call with no arguments to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- `todos` and `updates` are mutually exclusive.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- Update statuses as you make progress.

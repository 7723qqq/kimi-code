Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.

**When to use:**
- Multi-step tasks that span several tool calls
- Tracking investigation progress across a large codebase search
- Planning a sequence of edits before making them
- After receiving new multi-step instructions, capture the requirements as todos

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
- Every write passes the whole list through `todos`. To mark one item done or bump a progress percent, send the full list back with that one item changed — keep `id` and `parentId` on every item so the change lands on the same item rather than as a new one.
- A partial list replaces the list: items you leave out are removed, `id` values you invent are new items. Add or remove items only when the structure itself changes (add/remove items, re-tier milestones).

**Avoid churn:**
- Mark a task `done` as soon as it is finished, before you start the next one. Do not batch completions at the end.
- Before you write your final message, make sure the list matches what you actually did.
- An update can go in the same response as your next tool call; it does not need a step of its own.
- Do not re-send an unchanged list, and do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.
- When unsure of the current state, call query mode first (omit `todos`) to check the list before deciding what to update.
- While work is underway, keep exactly one task `in_progress`.
- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.

**How to use:**
- Call with `todos: [...]` to write the list. Each item has `title` and `status`. This is the only write parameter: the array you pass becomes the whole list.
- Call with no arguments to retrieve the current list without changing it.
- Call with `todos: []` to clear the list.
- Keep titles short and actionable (e.g. "Read session-control.ts", "Add planMode flag to TurnManager").
- Update statuses as you make progress.
- Only mark a task `done` when it is fully accomplished.
- Never mark a task `done` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.
- If you encounter a blocker, keep the blocked task `in_progress` or add a new pending task describing what must be resolved.

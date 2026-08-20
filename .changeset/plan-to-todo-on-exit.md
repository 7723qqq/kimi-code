---
"@moonshot-ai/agent-core-v2": minor
---

Auto-seed the TodoList from the approved plan on plan-mode exit so execution can start against a ready skeleton:

- `parsePlanToTodos` reads the plan markdown and turns `## <phase>` headings into milestones and the `- <step>` / `1. <step>` lists under them into leaf tasks (with `[x]` / `[ ]` mapped to `done` / `pending`).
- `tryConvertPlanToTodos` calls `ISessionTodoService.setTodos` when the agent has no existing todo list and the plan has recognizable structure; otherwise it skips silently and the post-plan-mode reminder nudges the model to build one manually.
- `AgentPlanService.exit` runs the conversion for every approved exit path (auto / manual / yolo / re-deserialize), passing through failures so plan-mode exit never blocks on todo wiring.
- `enter-plan-mode.md` now documents the plan structure convention the parser relies on, and the plan-mode exit reminder nudges the model to call TodoList when conversion is skipped.
- `plan_to_todo_converted` telemetry event records the seed (item count) for observability.

Tokens-before snapshots in `fullCompaction.test.ts` and the loop snapshot for `fails the turn after a filtered step completes` were updated to reflect the larger tool descriptions and reminders the integration introduces.
Use this tool proactively when you're about to start a non-trivial implementation task.
Getting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.

Use it when ANY of these conditions apply:

1. New Feature Implementation - e.g. "Add a caching layer to the API"
2. Multiple Valid Approaches - e.g. "Optimize database queries" (indexing vs rewrite vs caching)
3. Code Modifications - e.g. "Refactor auth module to support OAuth"
4. Architectural Decisions - e.g. "Add WebSocket support"
5. Multi-File Changes - involves more than 2-3 files
6. Unclear Requirements - need exploration to understand scope
7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision

Permission mode notes:
- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.
- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.
- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.
- In auto permission mode, ExitPlanMode exits plan mode without asking the user.
- Use EnterPlanMode only when planning itself adds value.

When NOT to use:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- User gave very specific, detailed instructions
- Pure research/exploration tasks

Once you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → `ExitPlanMode`) and enforces read-only access. For non-trivial tasks where you are unsure of the codebase structure or relevant code paths, use `Agent(subagent_type="explore")` to investigate first when the `Agent` tool is available.

**Plan file structure for automatic TodoList seeding.** Writing the plan in a structured form lets the system build the initial todo list for you as soon as the plan is approved, so you can start executing immediately instead of recreating the steps in TodoList yourself. Use this structure in the plan file (markdown):

- Each phase is a `## <phase name>` or `### <phase name>` heading — it becomes a `milestone` (first = start, last = finish, middle = phase).
- Under each phase, list concrete steps as `- <step text>` or `1. <step text>` — each becomes a leaf task (parentId = the milestone id).
- A completed step `- [x] <text>` seeds `status: 'done'`; a pending step `- [ ] <text>` or a bare `- <text>` seeds `status: 'pending'`.
- Steps at the top level (no preceding heading) and paragraphs without a list are ignored — you can use them for rationale that should not become a todo.

If the plan lacks this structure, the todo list is not seeded automatically and the post-plan-mode reminder will nudge you to build it via TodoList. If a todo list already exists for this agent at the moment of plan approval, the existing list is left untouched for the same reason.

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

Mode exclusivity:
- Plan, spec, swarm and tower modes are mutually exclusive — except plan and swarm, which may run together.
- Entering plan mode leaves spec or tower mode; swarm mode is left alone. The result names the mode it left, if any.

When NOT to use:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- User gave very specific, detailed instructions
- Pure research/exploration tasks

Once you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → `ExitPlanMode`) and enforces read-only access. For non-trivial tasks where you are unsure of the codebase structure or relevant code paths, use `Agent(subagent_type="explore")` to investigate first when the `Agent` tool is available.

**Plan file structure.** Write the plan as phases and steps — nothing is derived from it automatically, so this is for the user reading and approving it:

- Each phase is a `## <phase name>` or `### <phase name>` heading.
- Under each phase, list concrete steps as `- <step text>` or `1. <step text>`.
- Mark steps you have already completed `- [x] <text>`, pending ones `- [ ] <text>` or a bare `- <text>`.

After plan mode exits you build the todo list yourself: call TodoList to capture the next concrete steps before starting to execute.

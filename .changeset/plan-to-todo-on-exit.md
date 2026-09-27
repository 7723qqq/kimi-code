---
"@moonshot-ai/kimi-code": minor
---

Auto-seed the TodoList from an approved plan when plan mode exits, so execution starts against a ready skeleton: `## <phase>` headings become milestones and the step lists under them become tasks. A plan without that structure is left alone and the model is asked to build the list itself.
---
"@moonshot-ai/agent-core-v2": minor
---

Make goal completion judge-driven. When a goal has a completion condition, the runtime asks the independent judge after each judged turn; a rejection starts the next turn with the judge's reason, and a judge request or parse failure no longer counts as a pass. `UpdateGoal complete` only submits a candidate, and an accepted completion records the judge's reason.

Merge the failure and partial-progress behavior rule into the finish-the-authorized-task clause: a numbered request authorizes all of its items, and a failing step or partial result continues the open work instead of ending the run.

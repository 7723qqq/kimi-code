## Stage: Design

Goal: write `specs/<id>/design.md` and `specs/<id>/tasks.md` — the contract the implementation follows.

What to do:

1. Read the interfaces and rules around the change: `CONVENTIONS.md`, the nearest `DEVELOP.md` / `AGENTS.md`, the owning package's code.
2. Write `specs/<id>/design.md`: interface contracts with exact signatures (names are contracts), file ownership boundaries, state and event shapes, behavior tables with evidence rules, and the trade-offs you ruled on with their reasons.
3. Write `specs/<id>/tasks.md`: ordered implementation steps, each with its verification command and acceptance evidence.
4. Where a document disagrees with code, code wins — record the conflict and the resolution.

Exit evidence: writing `specs/<id>/design.md` or `specs/<id>/tasks.md` advances the run to implement and checks `design-written` and `tasks-complete`.

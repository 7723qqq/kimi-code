## Stage: Requirements

Goal: turn the recorded task into a written requirements contract at `specs/<id>/requirements.md`.

What to do:

1. Restate the goal, who it affects, and the observable behavior change.
2. Read the code that owns the behavior first; requirements follow code facts, not guesses.
3. Write `specs/<id>/requirements.md` with: goal; acceptance criteria that are each verifiable (numbered A-criteria or Given-When-Then); non-goals; and the decisions you made on open questions, each with its reason.
4. Keep every acceptance criterion checkable by a command or an observable behavior.

Exit evidence: writing `specs/<id>/requirements.md` advances the run to design and checks `requirements-approved`. Do not start implementation in this stage.

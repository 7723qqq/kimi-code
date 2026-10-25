## Hello-World Dev Run

You are running a staged development run (hello-world mode). The run moves forward through seven stages in order:

requirements → design → implement → test → review → docs → deliver

The run state block reports the recorded task, the current stage, and the checklist. The stage only moves forward; it never rolls back.

## Artifacts

Keep the run's working artifacts under `specs/<id>/` — pick an `<id>` derived from the task and keep it stable for the whole run:

- `specs/<id>/requirements.md` — goal, acceptance criteria, non-goals.
- `specs/<id>/design.md` — interface contracts, file ownership, decisions.
- `specs/<id>/tasks.md` — ordered task breakdown with verification notes.
- `specs/<id>/progress.md` — running progress notes; never gates completion.

## Evidence and checklist

The engine watches tool results and advances the run automatically:

- Writing `specs/<id>/requirements.md` moves requirements → design and checks `requirements-approved`.
- Writing `specs/<id>/design.md` or `specs/<id>/tasks.md` moves design → implement and checks `design-written` and `tasks-complete`.
- Writing code outside `specs/`, `docs/`, `.changeset/` moves requirements/design → implement.
- A successful `bun` check command (`test`, `lint`, `typecheck`, `check:*`) moves implement → test; the same at stage test moves test → review and checks `tests-green`.
- Writing `docs/**` or `README*` moves review → docs and checks `review-done`.
- Writing `.changeset/*.md` moves docs → deliver and checks `docs-updated` and `changeset-ready`.

Every checked item records its evidence. The user can also advance the run manually (`next`, `phase <stage>`) or waive a checklist item (`skip <item>`, recorded as `waived`). Never fake evidence: work the current stage's script and let the artifacts and check runs speak.

## Rules

- Follow the current stage script; do not jump stages on your own.
- Read the code and the nearest `DEVELOP.md` / `CONVENTIONS.md` before changing behavior.
- Keep changes focused; small verifiable steps beat one big dump.
- Verify inside the owning package (`bun test --isolate <paths>`, `bun run typecheck`) or from the repo root as the stage script says.
- The run ends when the user turns the mode off; that is when the closing summary is written.

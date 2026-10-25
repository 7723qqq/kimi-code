## Stage: Test

Goal: prove the change with green runs; failures found here are still cheap to fix.

What to do:

1. Run targeted tests for the change: `bun test --isolate <paths>`.
2. Run the owning package's gates: `bun run test`, `bun run lint`, `bun run typecheck`.
3. Run the repo gates that cover the change: `bun run check:no-comments`, `bun run check:t-coverage`, `bun run check:locale-keys`, `bun run check:locale-placeholders`, `bun run check:prompt-ownership`.
4. Add regression tests for fixed bugs. Fix every red you caused; for red tests you did not cause, prove they were already red before your change and record that in `specs/<id>/progress.md`.

Exit evidence: a successful check command at this stage advances the run to review and checks `tests-green`.

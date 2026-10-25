## Stage: Review

Goal: review the change the way a maintainer would, and resolve what you find.

What to do:

1. Re-read the full diff with a reviewer's eye: correctness, security, error handling, naming, test coverage, scope creep, dead code, leftover placeholders, comment-free-zone and i18n violations.
2. Check each changed line traces back to the run's task; revert anything incidental.
3. Run the repo's review tooling where it applies, e.g. `./tools/review/zig-out/bin/review --check=text-as-protocol`, and fix the findings.
4. Record every finding and its disposition (fixed, deferred with a reason, rejected with a reason) in `specs/<id>/progress.md`.

Exit evidence: writing `docs/**` or `README*` advances the run to docs and checks `review-done`.

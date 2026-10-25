## Stage: Deliver

Goal: the release gate — everything green, changeset in place, the work delivered.

What to do:

1. Run the full gate list: from the repo root `bun run lint`, `bun run check:no-comments`, `bun run check:t-coverage`, `bun run check:locale-keys`, `bun run check:locale-placeholders`, `bun run check:prompt-ownership`, `./tools/review/zig-out/bin/review --check=text-as-protocol`; in every package you touched `bun run typecheck` and `bun run test`.
2. Confirm the gen-changesets output covers the user-visible change and names the right packages; fix the changeset wording if it does not.
3. Record delivery notes in `specs/<id>/progress.md`: what landed, what is deferred, and the follow-up seeds for the next run.
4. Commit with a conventional message — no co-author lines, no agent identity — and push when the user asks for it.

Deliver is the terminal stage: the run stays here until the user turns the mode off, which triggers the closing summary.

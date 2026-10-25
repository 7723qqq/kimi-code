## Stage: Implement

Goal: land the code changes that satisfy the design, in focused steps.

What to do:

1. Follow `specs/<id>/design.md` signatures exactly. When code facts force a deviation, write the deviation down before making it.
2. Match the surrounding idioms; the smallest correct change wins. No drive-by refactors, no unrelated cleanups.
3. Respect the hard zones: `packages/agent-core-v2`, `packages/kap-server`, `packages/transcript` carry no comments at all; strings the code compares are protocol data and never localized; user-facing TUI copy goes through `t()` with en/zh kept in sync; tool and prompt (`*.md`) copy stays English.
4. Verify as you go inside the owning package: `bun test --isolate <paths>` for the tests you touched, `bun run typecheck` for the package.

Exit evidence: a successful `bun` check command (`test`, `lint`, `typecheck`, `check:*`) advances the run to test. Keep the diff limited to the design's file ownership.

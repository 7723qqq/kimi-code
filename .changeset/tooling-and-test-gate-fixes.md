---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/minidb": patch
---

Two development-gate fixes found while running this repository's own checks on Windows.

**The deep-import gate no longer fails on every run on Windows** (`packages/agent-core-v2/scripts/check-deep-imports.mjs`). The checker builds its lookup key from `path.relative()`, which is backslash-separated on Windows, while `deep-import-baseline.txt` stores forward-slash keys — so `baseline.has(key)` never matched and the tool reported all 262 baselined violations and exited 1. It is the same script behind `check:boundaries` (`lint:imports`), so both gates were unrunnable locally. The key's separators are now normalised to `/`, which is a no-op on the Linux CI it was written for.

**The minidb review suite no longer awaits synchronous reads** (`packages/minidb/test/review-round6.test.ts`). Eight `await`s sat on the synchronous `MiniDb.query`/`scan`, which `typescript-eslint(await-thenable)` rejects as errors — `bun run lint` was red for those eight lines alone. Awaiting a non-thenable is a no-op, so removing them changes no behaviour; the two `queryAsync` awaits, which are real, are untouched.

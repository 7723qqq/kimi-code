# Progress: 2.6.3 Request-Correctness Tranche

## Completed

- Approved the five-behavior tranche specification and read repository/package-specific guidance.
- Compared release-tag patches against the fork architecture and wrote `implementation-plan.md`.
- Deferred-tool fallback is equivalent here: local HTTP regression checks dynamic-to-static switching and actual serialized provider tools, including deferred builtin/user/unloaded MCP, policy filtering, uniqueness, no deferred marker, and unchanged history/registry/state. The bunfig-excluded tool-select E2E file also passes.
- `repeat` is a retryable `empty_response` before either consumer accepts content/tool calls. Kernel test confirms a repeated tool call is not dispatched.
- Missing finish is a retryable provider failure in both kernel and adapter. Tests cover nonempty, whitespace, unfinished tool args, all-null-but-present finish, empty/reasoning-only/filter classifications, real HTTP EOF, caller cancellation, reset between attempts, and retry content isolation. Existing successful session fixtures were updated to emit their intended completed finish event.
- OpenAI base parser now falls back to first-choice usage only when top-level usage is absent/null. Top-level data, including `{}`, wins. Kimi-specific duplicate fallback was removed; direct parser, Kimi, and real-socket cases cover usage and no-double-counting.
- Retry→overflow→compaction→answer test asserts exactly four provider calls, request records `0.1`, `0.2`, compaction, `0.3`, three paired loop-step UUIDs, failed retry linkage, answer retention, completed turn and cold-resume equality. The fork already has the required projection state; no production loop change was needed.
- `.upstream/PLAYBOOK.md` records all five tag-only commit IDs with per-behavior `ported`/`equivalent` probe locations. Release SHAs are absent from local `upstream/main`; they are not represented as fabricated ledger rows.
- Confirmed changeset `.changeset/quiet-lamps-retry.md` with the user. Package versions and release changelogs have not been changed.

## Verification

- Final focused run: 561 passed, 0 failed across 10 files; 17 snapshots. Separate tool-select E2E: 12 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun run test --per-file --parallel=1`: 549 files, 9,290 passed, 102 skipped, 0 failed, 0 errors in 287.1 s. Two files (`test/agent/task/reconcile.test.ts` and `test/agent/toolExecutor/toolExecutor.test.ts`) initially failed and passed the runner's automatic isolated retry; retain them as flaky observations. Earlier pooled runs had a Windows `EPERM: watch` unhandled error and are not counted as clean passes.
- `bun run build`: completed with the TS7 experimental warning and the external `bun:ffi` unresolved-import warning. Output was written to the existing ignored `packages/agent-core-v2/dist/` directory; Git tracks no files there, so there is no tracked build-artifact diff.
- Scoped `oxlint`: 0 errors (warnings remain). `oxfmt --check`, `bun run check:boundaries`, `bun run check:no-comments`, and `git diff --check`: passed.

## Follow-up status

- The verification above records the first request-correctness tranche, not later work. That tranche made no version or release-changelog changes and no commit or push.
- The later 2.6.3 behavior tranches, frozen release versions, lockfile, and bilingual release notes were subsequently completed. Their authoritative provenance, checks, and historical failures are recorded in `.upstream/PLAYBOOK.md` under the 2026-11-20 acceptance entries; they are no longer outstanding tranche work.
- Feedback disclosure/request attribution and the DeepSeek switch/continuation follow-ups are tracked on that same owning surface rather than extending this five-behavior specification.

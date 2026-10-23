---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

The agent now asks before it runs the whole test suite. A `Bash` call that runs every suite from the workspace root — `bun run test`, `test:watch`, `test:coverage`, `test:heavy`, a bare `bun test`, or `scripts/run-tests.mjs` / `scripts/run-test-heavy.mjs` — needs approval in Always Ask and Ask When Needed mode instead of running at once; a run scoped to one package (`cd packages/minidb && bun run test`) or one path (`bun test test/tui`) is untouched, and the policy is inactive in Never Ask mode. Set `[permission] full_suite_test_guard = false` or `KIMI_CODE_FULL_SUITE_TEST_GUARD=false` to restore the previous behavior.

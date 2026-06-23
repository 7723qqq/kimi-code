# TUI 全量接入 KAP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `apps/kimi-code` entry point create its harness through KAP by default, using a new internal helper that injects the default KAP server URL.

**Architecture:** A single internal helper `createTuiHarness` wraps `createKimiHarness` from `@moonshot-ai/kimi-code-sdk` and always passes `kap: { serverUrl }`. All source call sites import and use this helper. Tests that mock `createKimiHarness` continue to work; their assertions are updated to expect the injected `kap` option.

**Tech Stack:** TypeScript, Vitest, pnpm, `@moonshot-ai/kimi-code-sdk`, oxlint.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/kimi-code/src/utils/create-tui-harness.ts` | New helper: reads `KIMI_CODE_KAP_URL` and calls `createKimiHarness({ ..., kap: { serverUrl } })`. |
| `apps/kimi-code/src/main.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/src/cli/run-prompt.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/src/cli/run-shell.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/src/cli/sub/login-flow.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/src/cli/sub/provider.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/src/cli/sub/export.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/src/cli/sub/acp.ts` | Replace `createKimiHarness` import/call with `createTuiHarness`. |
| `apps/kimi-code/test/cli/*.test.ts` | Update harness-creation assertions to expect the `kap` option. |

---

## Constants

Default KAP server URL used throughout: `http://127.0.0.1:58627`.
Environment variable override: `KIMI_CODE_KAP_URL`.

---

## Task 1: Create the `createTuiHarness` helper

**Files:**
- Create: `apps/kimi-code/src/utils/create-tui-harness.ts`

- [ ] **Step 1: Write the helper**

```ts
import { createKimiHarness, type KimiHarness, type KimiHarnessOptions } from '@moonshot-ai/kimi-code-sdk';

const DEFAULT_KAP_SERVER_URL = 'http://127.0.0.1:58627';

export function createTuiHarness(options: Omit<KimiHarnessOptions, 'kap'>): KimiHarness {
  return createKimiHarness({
    ...options,
    kap: { serverUrl: process.env['KIMI_CODE_KAP_URL'] ?? DEFAULT_KAP_SERVER_URL },
  });
}
```

- [ ] **Step 2: Verify the file is valid TypeScript**

Run: `pnpm --filter @moonshot-ai/kimi-code typecheck`
Expected: no errors related to the new file.

- [ ] **Step 3: Commit**

```bash
git add apps/kimi-code/src/utils/create-tui-harness.ts
git commit -m "feat(tui): add createTuiHarness helper for KAP transport"
```

---

## Task 2: Replace `createKimiHarness` calls in source files

**Files:**
- Modify: `apps/kimi-code/src/main.ts:9,81-85`
- Modify: `apps/kimi-code/src/cli/run-prompt.ts:10,73-87`
- Modify: `apps/kimi-code/src/cli/run-shell.ts:6,61-76`
- Modify: `apps/kimi-code/src/cli/sub/login-flow.ts:8,15-18`
- Modify: `apps/kimi-code/src/cli/sub/provider.ts:27,509`
- Modify: `apps/kimi-code/src/cli/sub/export.ts:17,148-153`
- Modify: `apps/kimi-code/src/cli/sub/acp.ts:30,53-56`

For each file, perform the same two edits:
1. Replace the `createKimiHarness` import from `@moonshot-ai/kimi-code-sdk` with an import of `createTuiHarness` from `#/utils/create-tui-harness`.
2. Replace the `createKimiHarness(` call with `createTuiHarness(`; keep every existing option unchanged.

- [ ] **Step 1: Update `main.ts`**

Import change:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```
(remove `createKimiHarness` from the `@moonshot-ai/kimi-code-sdk` import list)

Call change (line 81):
```ts
  const harness = createTuiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    telemetry: telemetryClient,
  });
```

- [ ] **Step 2: Update `run-prompt.ts`**

Remove `createKimiHarness` from the SDK import. Add:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```

Call change (line 73):
```ts
  const harness = createTuiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    uiMode: PROMPT_UI_MODE,
    skillDirs: opts.skillsDirs,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { success: true });
        return;
      }
      track('oauth_refresh', { success: false, reason: outcome.reason });
    },
    sessionStartedProperties: { yolo: false, plan: false, afk: true },
  });
```

- [ ] **Step 3: Update `run-shell.ts`**

Remove `createKimiHarness` from the SDK import. Add:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```

Call change (line 61):
```ts
  const harness = createTuiHarness({
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { success: true });
        return;
      }
      track('oauth_refresh', {
        success: false,
        reason: outcome.reason,
      });
    },
    sessionStartedProperties: { yolo: opts.yolo, auto: opts.auto, plan: opts.plan, afk: false },
  });
```

- [ ] **Step 4: Update `login-flow.ts`**

Replace the SDK import with:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```

Call change (line 15):
```ts
  const harness = createTuiHarness({
    identity,
    uiMode: 'cli',
  });
```

- [ ] **Step 5: Update `provider.ts`**

Remove `createKimiHarness` from the SDK import if it is only used here. Add:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```

Call change (line 509):
```ts
        harness ??= createTuiHarness({ identity });
```

- [ ] **Step 6: Update `export.ts`**

Remove `createKimiHarness` from the SDK import. Add:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```

Call change (line 148):
```ts
    harness ??= createTuiHarness({
      homeDir: currentTelemetryBootstrap.homeDir,
      identity,
      telemetry: telemetryClient,
    });
```

- [ ] **Step 7: Update `acp.ts`**

Remove `createKimiHarness` from the SDK import. Add:
```ts
import { createTuiHarness } from '#/utils/create-tui-harness';
```

Call change (line 53):
```ts
      const harness = createTuiHarness({
        identity,
        uiMode: 'acp',
      });
```

- [ ] **Step 8: Run typecheck**

Run: `pnpm --filter @moonshot-ai/kimi-code typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/kimi-code/src/main.ts \
  apps/kimi-code/src/cli/run-prompt.ts \
  apps/kimi-code/src/cli/run-shell.ts \
  apps/kimi-code/src/cli/sub/login-flow.ts \
  apps/kimi-code/src/cli/sub/provider.ts \
  apps/kimi-code/src/cli/sub/export.ts \
  apps/kimi-code/src/cli/sub/acp.ts
git commit -m "feat(tui): route all harness creation through KAP by default"
```

---

## Task 3: Update test assertions

**Files:**
- Modify: `apps/kimi-code/test/cli/main.test.ts:292`
- Modify: `apps/kimi-code/test/cli/run-prompt.test.ts` assertions on harness constructor args
- Modify: `apps/kimi-code/test/cli/run-shell.test.ts` assertions on harness constructor args
- Modify: `apps/kimi-code/test/cli/export.test.ts` assertions on harness constructor args
- Modify: `apps/kimi-code/test/cli/login.test.ts` assertions on `createKimiHarness` calls
- Modify: `apps/kimi-code/test/cli/acp.test.ts` assertions on harness creation
- Modify: `apps/kimi-code/test/cli/goal-prompt.test.ts` assertions if any

The tests mock `@moonshot-ai/kimi-code-sdk` and intercept calls to `createKimiHarness`. Because `createTuiHarness` calls `createKimiHarness` with an extra `kap` option, assertions that check the options object must include `kap: { serverUrl: expect.any(String) }` (or the exact default URL).

- [ ] **Step 1: Add a shared test constant**

In each affected test file, add near the top:
```ts
const EXPECTED_KAP_OPTIONS = { serverUrl: expect.any(String) };
```

- [ ] **Step 2: Update `main.test.ts`**

Change the assertion at line 292 from:
```ts
expect(mocks.createKimiHarness).toHaveBeenCalledWith(expect.objectContaining({
  homeDir: mocks.harness.homeDir,
  identity: expect.objectContaining({ version }),
  telemetry: expect.any(Object),
}));
```
to:
```ts
expect(mocks.createKimiHarness).toHaveBeenCalledWith(expect.objectContaining({
  homeDir: mocks.harness.homeDir,
  identity: expect.objectContaining({ version }),
  telemetry: expect.any(Object),
  kap: EXPECTED_KAP_OPTIONS,
}));
```

- [ ] **Step 3: Update `run-prompt.test.ts` and `run-shell.test.ts`**

Find every assertion on `mocks.kimiHarnessConstructor` or `mocks.createKimiHarness` that checks the options object, and add:
```ts
kap: EXPECTED_KAP_OPTIONS,
```

- [ ] **Step 4: Update `export.test.ts`, `login.test.ts`, `acp.test.ts`, `goal-prompt.test.ts`**

Repeat the same pattern: any assertion on the harness-creation call arguments must include `kap: EXPECTED_KAP_OPTIONS`.

- [ ] **Step 5: Run targeted tests**

Run:
```bash
pnpm --filter @moonshot-ai/kimi-code test test/cli/main.test.ts test/cli/run-prompt.test.ts test/cli/run-shell.test.ts test/cli/export.test.ts test/cli/login.test.ts test/cli/acp.test.ts test/cli/goal-prompt.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/kimi-code/test/cli
git commit -m "test(tui): expect kap option in harness creation assertions"
```

---

## Task 4: Lint and full test verification

- [ ] **Step 1: Run lint on affected files**

Run:
```bash
pnpm -w run lint --max-warnings=0 -- apps/kimi-code/src/utils/create-tui-harness.ts apps/kimi-code/src/main.ts apps/kimi-code/src/cli/run-prompt.ts apps/kimi-code/src/cli/run-shell.ts apps/kimi-code/src/cli/sub/login-flow.ts apps/kimi-code/src/cli/sub/provider.ts apps/kimi-code/src/cli/sub/export.ts apps/kimi-code/src/cli/sub/acp.ts apps/kimi-code/test/cli/main.test.ts apps/kimi-code/test/cli/run-prompt.test.ts apps/kimi-code/test/cli/run-shell.test.ts apps/kimi-code/test/cli/export.test.ts apps/kimi-code/test/cli/login.test.ts apps/kimi-code/test/cli/acp.test.ts apps/kimi-code/test/cli/goal-prompt.test.ts
```
Expected: `Found 0 warnings and 0 errors.`

- [ ] **Step 2: Run full TUI test suite**

Run: `pnpm --filter @moonshot-ai/kimi-code test`
Expected: `Test Files ... passed` with no failures.

- [ ] **Step 3: Commit any final fixes**

If lint or tests required fixes, commit them with an appropriate conventional-commit message.

---

## Task 5: Update changeset

- [ ] **Step 1: Update the existing CLI changeset**

The existing changeset `.changeset/store-goal-queue-under-client-home.md` already bumps `@moonshot-ai/kimi-code` at `patch`. Since this PR makes the CLI default to KAP, the user-facing change is broader. Replace that file with a single CLI changeset that captures both changes, or keep it and add a second CLI changeset.

Recommended single changeset `.changeset/tui-kap-integration.md`:
```markdown
---
"@moonshot-ai/kimi-code": minor
---

Use the Kimi Agent Protocol as the default transport for local TUI sessions.
```

Remove `.changeset/store-goal-queue-under-client-home.md` if the single changeset is used.

- [ ] **Step 2: Validate changeset status**

Run: `pnpm changeset status`
Expected: `@moonshot-ai/kimi-code` listed at `minor`; `@moonshot-ai/kimi-code-sdk` still at `minor` from the earlier SDK changeset.

- [ ] **Step 3: Commit**

```bash
git add .changeset
git commit -m "chore: add changeset for TUI KAP integration"
```

---

## Self-Review Checklist

- [ ] Spec coverage: every design section (default URL, helper, call sites, tests, changeset) has at least one task.
- [ ] No placeholders: no "TBD", "TODO", or vague steps remain.
- [ ] Type consistency: `createTuiHarness` accepts `Omit<KimiHarnessOptions, 'kap'>` and returns `KimiHarness` in all call sites.
- [ ] Test coverage: all source files with harness creation have corresponding test updates.

# Tasks — Plan/Spec mode exclusivity

Ordered so each task is independently verifiable. Tasks 1–3 follow Approach A from design.md; if the
user picks Approach B or C at exit, task 2 is rewritten and its criteria are unchanged.

## T1 — Make spec mode report its own telemetry mode (R4)

Change `specService.ts:92` (`restoreTelemetryMode`) and `:120` (`enter`) from `{ mode: 'plan' }` to
`{ mode: 'spec' }`. Leave `planService.ts:153` and `:170` as `{ mode: 'plan' }`.

**Acceptance criteria**

- A test asserting `telemetry.setContext` was called with `{ mode: 'spec' }` after `specService.enter()`
  fails on the pre-change code and passes after. (The existing spec service tests in
  `packages/agent-core-v2/test/features/spec/` already stub telemetry; extend that stub to record calls.)
- `rg "mode: 'plan'" packages/agent-core-v2/src/features/spec` returns no match.
- `rg "mode: 'plan'" packages/agent-core-v2/src/features/plan` still returns its two matches.

## T2 — Add the session mode coordinator (R1, R3, R5)

Create `packages/agent-core-v2/src/session/mode/` with a service exposing
`setMode(target: 'plan' | 'spec' | 'none'): Promise<void>`, injecting `IAgentPlanService` and
`IAgentSpecService` (Approach A in design.md).

**Acceptance criteria**

- `setMode('spec')` while plan mode is active leaves exactly one mode active afterwards:
  `planService.status()` returns `null` **and** `specService.status()` is non-null. A test that asserts
  both of those fails on today's code (where both are non-null) and passes after.
- `setMode('plan')` while spec mode is active symmetrically leaves only plan active.
- When `specService.enter()` throws — forced by stubbing `hostFs.mkdir` to reject — the session is **not**
  in plan mode either: `planService.status()` returns `null` and `specService.status()` returns `null`.
  (Today, and under a naive "exit plan first" change, a throw after `plan.cancel()` would leave the
  session with no mode; the criterion is that the pre-existing mode is restored instead.)
- Calling `setMode('spec')` while spec mode is already active is a no-op and does **not** throw
  `Already in spec mode`.
- Replay: after dispatching the transitions and re-running replay, the reconstructed state has the same
  single active mode — asserted via the existing `specOps.test.ts` / `planOps.test.ts` replay helpers,
  adding a case where `SpecModeExit` and `PlanModeEnter` appear in the same log.
- `pnpm -C packages/agent-core-v2 test` passes.

## T3 — Route all entry points through the coordinator (R1, R5)

Point `sdk-rpc-client-v2.ts:1832-1851` (`setPlanMode` / `setSpecMode`) at `setMode`, and update
`enterSpecModeTool.ts:25-39` / `enterPlanModeTool.ts:25-39` to go through it. Where the tools' behaviour
on a conflicting mode changes, update `enter-spec-mode.md` / `enter-plan-mode.md` to match.

**Acceptance criteria**

- An RPC-level test — `setPlanMode(true)` then `setSpecMode(true)` against a real session — ends with
  `getStatus().specMode === true` and `getStatus().planMode === false`.
- A tool-level test calling `EnterPlanMode` while spec mode is active ends with only plan mode active,
  and its `output` string names which mode was left.
- `pnpm typecheck` passes.
- The generator for `packages/agent-core-v2/docs/state-manifest.d.ts` and `wire-manifest.d.ts` produces
  no diff (the coordinator adds no new state or event class).

## T4 — Make Shift+Tab mode-aware (R2)

In `editor-keyboard.ts:275-291`, read `host.state.appState.specMode` and choose the target mode; route
through the same path the coordinator exposes rather than `handlePlanCommand` alone
(`kimi-tui.ts:1166-1168`). Recommended semantics: leave the exclusive mode when either is on, otherwise
enter plan.

**Acceptance criteria**

- With `appState.specMode === true` and `appState.planMode === false`, pressing `Shift+Tab` leaves both
  false and the session's `planMode` false — i.e. it exits spec mode rather than entering a stacked pair.
  On today's code this same input sets `planMode` true and leaves `specMode` true, so the test fails
  before the change.
- With both false, `Shift+Tab` enters plan mode (today's behaviour, unchanged) — pinned by a test so the
  fix cannot regress it.
- The session-less path still works: with `host.session === undefined`, `Shift+Tab` lazily creates a
  session and then applies the toggle, as `editor-keyboard.ts:282-289` does today.
- If the user picked the "switch to plan" or "cycle" semantics at exit, an equivalent test pins that
  target instead; the first criterion (never leaving both active) is unaffected.
- `pnpm -C apps/kimi-code test` passes.

## T5 — Verify the indicator and the guards agree (R6)

**Acceptance criteria**

- A footer test asserting the mode slot never contains both `plan` and `spec` for any reachable
  `AppState` after T1–T4; if `planMode && specMode` is still reachable mid-transition, add the branch
  and test it rather than dropping the assertion.
- Manual end-to-end check, recorded in the PR description: start a session, `/plan`, then `/spec`, and
  confirm the footer shows one badge, not two, and that the spec directory is writable (today this write
  fails with `Spec mode is active. You may only write inside the current spec directory.`).
- `/plan` and `/spec` each still report `already on` / `already off` for a no-op, as
  `config.ts:134-137` and `config.ts:181-184` do today.

## T6 — Changeset and docs

**Acceptance criteria**

- `.changeset/*.md` covers the user-visible change: `Shift+Tab` no longer stacks the two modes, and
  entering one mode leaves the other. Follow the repo's changeset convention (see
  `.agents/skills/gen-changesets/SKILL.md`).
- If `Shift+Tab`'s semantics change, `tui.chrome.tips.shiftTabPlanMode` and
  `tui.dialogs.helpPanel.shortcuts.shiftTab` are updated in both `apps/kimi-code/src/i18n/locales/en.ts`
  and `zh.ts`, and `node scripts/check-locale-keys.mjs` passes.
- `docs/{en,zh}/reference/slash-commands.md` states the exclusivity rule if `/plan` and `/spec` now
  affect each other.

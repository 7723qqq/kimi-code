# Tasks

Approach A from design.md: complete and expose the existing `AgentModeMutexService`. Each task lists the
test that must fail before it and pass after. Run the repo's own commands (`bun run test`,
`bun run typecheck`) — do not substitute ad-hoc scripts.

## T1 — Give the mutex a real contract (R2)

Extend `IAgentModeMutexService` (`packages/agent-core-v2/src/agent/modeMutex/modeMutex.ts:3-8`) with
`ExclusiveReviewMode`, `activeMode()`, `switchTo()`, `leave()`, and implement them in
`AgentModeMutexService`, injecting `IAgentSpecService` alongside the existing three.

**Acceptance criteria**

- `activeMode()` returns `null` on a fresh agent; `'plan'` after `switchTo('plan')`; `null` after
  `leave('plan')`.
- `switchTo('spec')` with plan active leaves `planService.status() === null` **and**
  `specService.status() !== null`. Fails on today's code, where both are non-null.
- `switchTo('spec')` while spec is already active is a no-op and does not throw `Already in spec mode`.
- `switchTo('plan')` then `switchTo('swarm')` leaves both active (R6, `plan`+`swarm` allowed) — pinned so
  the new conflict table cannot over-evict.
- New cases in `test/agent/modeMutex/modeMutex.test.ts`; the existing 6 cases still pass unchanged.
- `bun run --filter '@moonshot-ai/kimi-agent-core-v2' test` passes (check the real package name in
  `packages/agent-core-v2/package.json` and use it).

## T2 — Extend the conflict table (R1, D1, D2)

Add the four missing edges from design.md's table: plan↔spec, spec↔tower, spec↔swarm and inverses, in
both `switchTo` and the existing event subscriptions (`modeMutexService.ts:26-41`).

**Acceptance criteria**

- Parameterized test over every ordered pair from the table: after `switchTo(b)` from `a`, exactly the
  modes listed as allowed remain active. The `plan`+`swarm` cell asserts both stay.
- `switchTo('tower')` with spec active evicts spec (D2). Fails on today's code.
- `switchTo('spec')` with tower active evicts tower. Fails on today's code.
- The event-subscription path (a bare `new TowerModeEnter(...)` published on the bus, no `switchTo`)
  still evicts plan and swarm, and now also evicts spec.

## T3 — Restore the previous mode on failed entry (R4)

Implement the restore in `switchTo` per the pseudocode in design.md.

**Acceptance criteria**

- With plan active, stub `specService.enter()` to reject; `switchTo('spec')` rejects **and**
  `planService.status() !== null` afterwards (the previous mode is restored, not lost).
- On today's code the equivalent scenario leaves the session with no mode — the test fails before the
  change.
- If the restore itself also rejects, the original error is the one that propagates, and both failures
  are recorded (assert on the telemetry/log call, not on a thrown wrapper).

## T4 — Route every entry point through the mutex (R3)

Rewire the `EnterSpecMode` / `EnterPlanMode` tools, the `setPlanMode` / `setSpecMode` / `setTowerMode`
RPCs (`sdk-rpc-client-v2.ts:1832-1851`), and the swarm callers (`AgentSwarm` tool path and
`/swarm`) per design.md. Keep the mutex one-directional: mode services must not inject it.

**Acceptance criteria**

- RPC-level: `setPlanMode(true)` then `setSpecMode(true)` on a real session ends with
  `getStatus().specMode === true` and `getStatus().planMode === false`.
- Tool-level: calling `EnterPlanMode` while spec mode is active ends with only plan active, and the
  tool's `output` names the mode it evicted.
- If entry now evicts, `enter-spec-mode.md` / `enter-plan-mode.md` say so (assert the prompt text
  mentions the evicted mode, or the change is explicitly documented in the changeset).
- `bun run check:boundaries` and `bun run check:deep-imports` pass (no DI cycle).

## T5 — Make Shift+Tab mode-aware (R7, D4)

> **Superseded semantics (rewritten 2026-10-07).** This task originally specified "leave the active
> exclusive mode, else enter plan", with `swarm` peeled before `plan`. That shape shipped and was then
> found defective in use: leaving and entering were two separate presses, so getting from Spec to Plan
> took two presses and the second one *appeared to undo the first* ("切出来个 plan，然后再切就没了").
> The accepted replacement is a **cycle**, now implemented. The acceptance criteria below are the
> current ones; the original list is preserved underneath for provenance.

Rewrite `editor-keyboard.ts` to cycle Plan and Spec on each press: with neither active, enter Plan;
then switch to Spec; then turn Spec off. Add the switch/leave handlers next to `handlePlanToggle`
(`kimi-tui.ts`), routed through the same RPC surface the slash commands use.

**Acceptance criteria (current)**

- The cycle is `none → plan → spec → none`, one transition per press. Derived by `nextReviewMode()`
  from a `ReviewCycleState` — a shape carrying **only** `planMode` and `specMode`.
- From Spec, a press turns Spec off and does **not** enter Plan. (This is the behaviour the cycle
  defines; it is deliberately different from the original "leave, else enter plan" rule, and users who
  expect Spec → Plan directly should say so — changing it means redefining the cycle order.)
- `Shift+Tab` never enters or leaves Swarm or Tower. Their paths remain `/swarm` and `/tower`
  exclusively. Enforced structurally, not by a runtime check: `ReviewCycleState` cannot express those
  flags, `reviewCycleState()` returns `null` while either is active (so the press is a no-op), and
  `ActiveExclusiveMode` is `'plan' | 'spec'` so a leave call for either mode fails to compile.
- The session-less path (`host.session === undefined`) still lazily creates a session and then applies
  the transition; routing through `reviewCycleState()` must not bypass it.
- A user-initiated exit is **not** blocked by spec's `ExitSpecMode` approval gate
  (`specService.ts:220-225`): assert the leave path succeeds while permission mode is not `auto`.
- Tests assert the **resulting state**, not merely that a handler was called — the original suite's
  `expect(handleExclusiveModeLeave).toHaveBeenCalledWith('spec')` passed while the feature was broken,
  because it never checked that Spec was actually off afterwards.
- Isolation is pinned by tests that fail if the coupling returns: removing the swarm/tower guard from
  `reviewCycleState()` must turn them red (verified — 5 cases fail).

**Original acceptance criteria (superseded, kept for provenance)**

- With `appState.specMode === true`, `Shift+Tab` leaves both `specMode` and `planMode` false.
- With `appState.planMode === true` and swarm off, `Shift+Tab` leaves plan (both false).
- With both false, `Shift+Tab` enters plan.
- With `plan`+`swarm` both active, the first press leaves swarm and the second leaves plan.
- The session-less path still lazily creates a session, then applies the toggle.
- A user-initiated exit is not blocked by spec's `ExitSpecMode` approval gate.

## T6 — Indicators tell the truth (R8, D6)

Add spec/swarm rows to `status-panel.ts:112-127` and pass them from `commands/info.ts:185-186`. Add
`specMode` / `swarmMode` / `towerMode` to `StatusLinePayload` (`status-line-command.ts:17-28`) and feed
them from `footer.ts:673-688`. Extend the border highlight
(`kimi-tui.ts:2444-2448`) to the other three modes.

**Acceptance criteria**

- `/status` output contains a spec row reading `on` while spec mode is active — a test on
  `buildStatusReportLines` fails on the pre-change signature (the field does not exist).
- The status-line payload JSON contains `specMode`, `swarmMode`, `towerMode`; an existing consumer
  reading only `permissionMode`/`planMode` is unaffected (additive).
- `updateEditorBorderHighlight` sets `borderHighlighted === true` in spec, swarm and tower mode, not
  just plan — a test per mode, each failing before.
- No footer test regresses on the `swarm-plan` combined badge (`footer.ts:593-598`).

## T7 — `/spec` and `/swarm` confirm the mode took (R9, D7)

Adopt the `/tower` re-read pattern (`commands/tower.ts:71-83`) in `handleSpecCommand`
(`config.ts:167-202`) and `handleSwarmCommand` (`commands/swarm.ts:170`).

**Acceptance criteria**

- When `setSpecMode` resolves but the session's status still reports `specMode: false`, the command
  shows an error and sets `appState.specMode` from the status — it does **not** show `specModeOn`. Fails
  on today's code, which reports success unconditionally.
- The same for `/swarm` with a stubbed status.
- The happy path still shows `specModeOn` with the spec directory path (`config.ts:193-197`).

## T8 — Spec-mode telemetry stops claiming to be plan (carried from the prior spec)

`specService.ts:92` and `:120`: `{ mode: 'plan' }` → `{ mode: 'spec' }`.

**Acceptance criteria**

- A test asserting the telemetry context after `specService.enter()` is `{ mode: 'spec' }` fails before
  and passes after.
- `rg "mode: 'plan'" packages/agent-core-v2/src/features/spec` returns no match, while
  `.../features/plan` still has its two.

## T9 — Changeset, docs, locale

**Acceptance criteria**

- `.changeset/*.md` covers: the exclusive-mode rule, `Shift+Tab` semantics, the new status-line payload
  fields, and the `/status` rows. Follow `.agents/skills/gen-changesets/SKILL.md`.
- If any user-visible string changed, `en.ts` and `zh.ts` are both updated and
  `bun run check:locale-keys` passes.
- `docs/{en,zh}/reference/slash-commands.md` states the exclusivity rule; if the status-line payload is
  documented anywhere under `docs/`, it lists the new fields.

## T10 — Full verification

**Acceptance criteria**

- `bun run typecheck` passes from the repo root (it builds packages first, then typechecks every
  workspace — allow it the time).
- `bun run test` passes.
- `bun run lint` passes for the touched files.
- `packages/agent-core-v2`'s `gen:state-manifest` / `gen:wire-manifest`: the **wire** manifest must
  produce no diff (this change adds no event class). The **state** manifest is expected to differ by the
  two `lastTransition?: 'cancel' | 'exit'` lines on the `spec` and `plan` entries, which come from
  earlier uncommitted work rather than from this change; regenerate it rather than hand-editing, and
  confirm the diff is exactly those lines. Record the command output in `progress.md`.
  > The original criterion said "no diff" for both, on the assumption that this change adds no state. It
  > adds none, but the generated file was already stale before this work began, so a clean "no diff" was
  > never achievable here. The observable requirement is the *content* of the diff, not its absence.
- End-to-end manual check recorded in `progress.md`: start a session, `/plan`, then `/spec`, confirm one
  badge in the footer and that the spec directory **is** writable (the D1 deadlock is gone); then press
  `Shift+Tab` and confirm it leaves spec rather than stacking. Note: `Shift+Tab`'s semantics were
  changed again after this work (see `progress.md`), so the shortcut no longer "leaves spec" as a
  one-press rule — assert the mode set the current cycle defines.

## Suggested order

T1 → T2 (the rule) → T3 (failure semantics) → T4 (wire the entry points) → T5 (the shortcut) →
T6/T7/T8 (indicators, confirmations, telemetry) → T9 → T10.

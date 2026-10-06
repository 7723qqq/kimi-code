# Requirements — Spec mode must not stack with Plan mode

## Goal

Today a session can be in spec mode and plan mode at the same time, and `Shift+Tab` — the documented
shortcut for switching modes — moves only the plan half. This spec defines what the two modes owe each
other and what the toggle must do, so the indicator, the write guard, and the reminder injections all
agree on a single active mode.

Every claim below names the file it came from; that investigation is the evidence base.

## Observed behaviour (evidence)

**The two modes are independent state, with no mutual awareness.**

- Plan mode owns `planKey` (`packages/agent-core-v2/src/features/plan/planOps.ts:87`), served by
  `AgentPlanService` (`.../plan/planService.ts`).
- Spec mode owns `specKey` (`packages/agent-core-v2/src/features/spec/specOps.ts:85`), served by
  `AgentSpecService` (`.../spec/specService.ts`).
- Neither `enter()` consults the other. The only precondition each checks is its own:
  `specService.ts:110-112` throws `Already in spec mode`; `planService.ts:161-163` throws
  `Already in plan mode`. There is no cross-check anywhere in `packages/agent-core-v2/src`.

**Entering one mode does not exit the other.**

- `/spec` → `handleSpecCommand` (`apps/kimi-code/src/tui/commands/config.ts:167-202`) → `setSpecMode`
  → `sdk-rpc-client-v2.ts:1842-1851`, which calls `spec.enter()` / `exit()` and nothing else.
- `/plan` → `handlePlanCommand` (`config.ts:109-140`) → `setPlanMode` → `sdk-rpc-client-v2.ts:1832-1836`,
  which calls `enterPlan()` / `cancelPlan()` and nothing else.

**Both badges render side by side, so the stacking is user-visible.**

- `footer.ts:593-605` pushes `plan` (and the `swarm-plan` composite badge) and, independently,
  `spec:${stage}` into the same `modes` array, joined with a space.
- `session-event-handler.ts:880-881` patches `planMode` and `specMode` from two separate status fields,
  so neither clears the other in the TUI.

**The stacking has a real cost, not just a cosmetic one.** `planService.ts:107-117` vetoes every write
outside the plan file while spec mode's guard (`specService.ts:238-267`) vetoes every write outside the
spec directory. With both active the two guards intersect to the empty set: no file is writable at all,
including the spec documents spec mode just asked the model to produce.

**Spec mode already masquerades as plan in telemetry.**

- `specService.ts:92` and `:120` set `telemetry.setContext({ mode: 'plan' })`, so spec mode is reported
  as plan mode downstream even though the two are separate states upstream.

**`Shift+Tab` toggles plan mode only.**

- `custom-editor.ts:563-566` matches `shift+tab` and calls `onShiftTab`.
- `editor-keyboard.ts:275-291`: `next = !planMode`, then `host.handlePlanToggle(next)`. `specMode` is
  never read and never written.
- `kimi-tui.ts:1166-1168` → `handlePlanCommand(this, next ? 'on' : 'off')`.
- `/plan` itself refuses a no-op (`config.ts:134-137`), so with spec mode active `Shift+Tab` can only
  flip the plan half — it can neither enter, exit, nor observe spec mode.

**The `swarm` + `plan` pair sets the precedent.**

- `footer.ts:593-598` already collapses `planMode && swarmMode` into a single `swarm-plan` badge rather
  than showing both, and `footer.ts:603` renders `spec:${stage}` when `specMode` is set — the footer
  simply never had a `plan` + `spec` case.

## Requirements

R1. **At most one of plan mode and spec mode is active at any time.** Entering either mode from any
    entry point (`EnterPlanMode` / `EnterSpecMode` tools, `/plan`, `/spec`, `Shift+Tab`, a startup
    flag, or a resume) leaves the session with exactly one of them active.

R2. **`Shift+Tab` switches between the two modes when spec mode is active.** With spec mode on,
    `Shift+Tab` moves to the other mode rather than toggling the plan half of a stacked pair. The exact
    target mode is a design decision (see design.md).

R3. **The transition is recorded as a durable event**, so a replay or resume reconstructs the same
    single active mode instead of re-deriving two. Spec mode's `lastTransition: 'cancel' | 'exit'`
    (`specOps.ts:11-14`) exists for this replay disambiguation and must stay meaningful.

R4. **Telemetry stops conflating spec with plan.** Spec mode reports its own mode rather than `'plan'`,
    so a downstream reader can tell which mode was active.

R5. **A mode that refuses to be entered leaves the other mode untouched.** If the target mode's
    `enter()` throws — its own "already active" guard, or a filesystem failure creating the spec
    directory (`specService.ts:115`) — the session must not end up in the mode it was trying to leave.

R6. **The indicator reflects the single active mode.** The footer and the status panel never show
    `plan` and `spec` as simultaneously active once R1 holds. The `swarm-plan` composite badge stays as
    it is.

R7. **Behaviour is pinned by tests that fail on today's code**, at the layer where the rule lives:
    core-service tests for R1/R3/R5, RPC or TUI tests for R2/R4.

## Audience

Maintainers of `packages/agent-core-v2` (the two mode services and their guards) and of
`apps/kimi-code/src/tui` (the shortcut, the slash commands, the footer). The user-facing outcome is for
anyone who presses `Shift+Tab` or types `/spec` and expects the mode indicator to mean something.

## Boundaries

- The two modes keep separate state, services, directories, and guards. This spec makes them mutually
  exclusive and mutually aware; it does not merge them into one state machine.
- Both tool entry points (`EnterSpecMode`, `EnterPlanMode`) are in scope, because they are entry points
  like any other.
- `swarm` + `plan` (the `swarm-plan` badge) is settled behaviour and is left alone. Exclusivity is not
  extended to `swarm`, `tower`, or `permission` mode.

## Out of scope

- Merging spec mode and plan mode into a single service or a single state.
- Changing what either mode's write guard allows inside its own directory.
- The `ExitSpecMode` / `ExitPlanMode` approval review flow (`exitSpecModeReview.ts`,
  `exitPlanModeReview.ts`).
- Non-TUI hosts (`apps/vscode`, `apps/vis`, `apps/kimi-web`, `packages/acp-server`) beyond keeping them
  compiling against any changed status contract.
- The `specStage` progression (`spec.ts:20`, `stageFor` in `specService.ts:275-280`).

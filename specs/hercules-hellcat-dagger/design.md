# Design — Making Plan and Spec modes mutually exclusive

## Where the rule belongs

The exclusivity rule (R1) is a property of the *pair*, not of either service alone, so it cannot live
inside `AgentSpecService.enter()` or `AgentPlanService.enter()` without one service depending on the
other. Three placements are possible; the choice between them is the main design decision and is passed
to the user at exit.

The one part that is *not* a choice: whichever placement wins, the mutual exclusion must happen
**before** the target mode's own precondition check, and a failure to leave must abort the entry
(R5). Concretely, `specService.enter()` currently does:

```
if (this.isActive) throw ... 'Already in spec mode'     // specService.ts:110-112
await this.hostFs.mkdir(dir, { recursive: true })       // :115  — can throw
await this.dispatch(new SpecModeEnter(...))             // :116
```

So the sequence becomes: leave-the-other-mode → own precondition → fallible setup → dispatch. If
leave-the-other-mode itself fails, nothing has been dispatched and there is nothing to roll back.

## Approach A (recommended) — a session-level mode coordinator

Introduce a `SessionModeService` in `packages/agent-core-v2/src/session/mode/` that owns the
"which exclusive mode is active" question and is the only thing `setPlanMode` / `setSpecMode` /
the two `Enter*` tools call.

- It injects `IAgentPlanService` and `IAgentSpecService` and exposes
  `setMode(target: 'plan' | 'spec' | 'none'): Promise<void>`.
- `setMode('plan')`: if spec is active, `spec.exit()`; then `plan.enter()` unless already active.
- `setMode('spec')`: if plan is active, `plan.cancel()`; then `spec.enter()` unless already active.
- `setMode('none')`: cancel/exit whichever is active.

Each service keeps its own `enter`/`exit`/`cancel` and its own guard; the coordinator is the only caller
that knows both exist. Signalling "the other mode left" needs no new event class: `SpecModeExit` and
`PlanModeCancel` are already durable and already flip their flags, so a replay reaches the same
single-mode state (R3).

`specService.enter()` regains a clean contract: it asserts only its own precondition, and the
coordinator is responsible for having cleared the other. Because `enter()` no longer has to reach across,
the two services stay independent — no new dependency edge between `plan` and `spec`.

## Approach B — cross-service guards in each `enter()`

`AgentSpecService` injects `IAgentPlanService` and calls `plan.cancel()` at the top of `enter()`, and
`AgentPlanService` does the mirror image. Fewer files, and every entry point that already calls
`enter()` is fixed for free.

Rejected because it creates a dependency cycle at the DI level (`spec → plan → spec`), and because the
policy is now duplicated in two places that can drift apart. It also makes each service's `enter()`
harder to test in isolation, since a unit test of `AgentSpecService` must now stub the plan service.

## Approach C — enforce in the RPC facade only

Make `sdk-rpc-client-v2.ts:1832-1851` call the other mode's exit before entering. Smallest diff, and it
covers the two slash commands.

Rejected because it does not cover the `EnterSpecMode` / `EnterPlanMode` **tools**, which call the
services directly (`enterSpecModeTool.ts:35`, `enterPlanModeTool.ts:35`). A model that calls
`EnterPlanMode` while spec mode is on would still stack the two, which is the same defect one layer down.

## Shift+Tab target mode (R2)

Three behaviours are defensible when spec mode is active:

- **Cycle through all modes** — `off → plan → spec → off`. Predictable and extensible, but it makes
  `Shift+Tab` a two-press trip to get back to normal mode, and the current tip text
  (`tui.chrome.tips.shiftTabPlanMode`, `tips.ts:55`) only mentions plan.
- **Toggle spec off / leave the exclusive set** — with spec active, `Shift+Tab` exits to normal mode.
  Matches `Shift+Tab`'s existing meaning as "get out of review mode", and keeps it to one press.
- **Switch to plan** — with spec active, `Shift+Tab` moves to plan. Literal "switch between the two",
  but it silently discards the spec context and leaves the user in a different write guard than the one
  they were in.

Recommendation: **toggle to plan mode when plan is off and spec is off; exit to normal mode when either
is on** — i.e. `Shift+Tab` remains "toggle the review mode", except that turning plan on while spec is
active first exits spec (the coordinator makes that atomic). This keeps today's single-press semantics
and needs no change to the tip text. The other two options are passed to the user at exit.

## Telemetry (R4)

`specService.ts:92` (`restoreTelemetryMode`) and `:120` (`enter`) set `{ mode: 'plan' }`. Give the spec
mode its own context value (`{ mode: 'spec' }`) at both call sites. `planService.ts:153` and `:170`
keep `{ mode: 'plan' }`. This is the one change that reaches outside the exclusivity work and is called
out separately so it can be dropped if a downstream dashboard depends on the current conflation.

## Indicator (R6)

Once R1 holds, `footer.ts:593-605` never sees `planMode && specMode` together, so no footer change is
strictly required. Add a defensive `planMode && specMode` branch only if the tests show the two can
still be observed mid-transition; do not invent a new composite badge for a pair that can no longer
occur.

## Files touched

| File | Change |
| --- | --- |
| `packages/agent-core-v2/src/session/mode/sessionModeService.ts` | new — the coordinator (Approach A) |
| `packages/agent-core-v2/src/features/plan/planService.ts` | unchanged contract; tests only |
| `packages/agent-core-v2/src/features/spec/specService.ts` | telemetry `mode: 'spec'` (R4) |
| `packages/node-sdk/src/sdk-rpc-client-v2.ts:1832-1851` | route `setPlanMode` / `setSpecMode` through the coordinator |
| `apps/kimi-code/src/tui/controllers/editor-keyboard.ts:275-291` | read `specMode` and pick the target mode |
| `apps/kimi-code/src/tui/kimi-tui.ts:1166-1168` | `handlePlanToggle` → a mode-aware toggle |

## Constraints

- `packages/agent-core-v2/docs/state-manifest.d.ts` and `wire-manifest.d.ts` are generated; if the
  coordinator adds no new state and no new event, they should not change. Re-run the generator and
  confirm it is a no-op rather than hand-editing them.
- `EnterSpecMode` / `EnterPlanMode` are model-facing tools with prompt files
  (`enter-spec-mode.md`, `enter-plan-mode.md`). If their behaviour on a conflicting mode changes
  (e.g. they now leave the other mode instead of erroring), the prompt text must follow.
- The `ExitSpecMode` tool currently requires approval unless `modeService.mode === 'auto'`
  (`specService.ts:221`). The coordinator must not bypass that review when it exits spec on the user's
  behalf via `Shift+Tab` — an explicit user toggle is not the model exiting.

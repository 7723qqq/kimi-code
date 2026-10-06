# Design — Turning the mode mutex into a real contract

## The key decision: use the mutex that already exists

The prior spec (`specs/hercules-hellcat-dagger`) proposed a **new** `SessionModeService`. The sweep shows
that is largely unnecessary: `AgentModeMutexService` (`packages/agent-core-v2/src/agent/modeMutex/modeMutexService.ts`)
already implements this exact rule for three of the six flags, is already registered at agent scope, and
already has a test file (`test/agent/modeMutex/modeMutex.test.ts`, 6 cases). It is simply incomplete and
unreachable.

So the recommended approach is to **complete and expose the existing mutex** rather than add a parallel
service. This is a smaller diff, reuses a tested mechanism, and removes the "two things own exclusivity"
hazard. Alternatives are below; this is the one passed to the user.

## Contract

`IAgentModeMutexService` (`modeMutex/modeMutex.ts:3-8`) gains:

```ts
export type ExclusiveReviewMode = 'plan' | 'spec' | 'swarm' | 'tower';

/** The mode currently active, or null. plan+swarm reads as 'plan'. */
activeMode(): ExclusiveReviewMode | null;

/** Evict every mode that conflicts with `target`, then enter `target`.
 *  Restores the previous mode if the target's enter() throws. No-op if
 *  `target` is already active. */
switchTo(target: ExclusiveReviewMode): Promise<void>;

/** Leave `target` if it is the active mode. */
leave(target: ExclusiveReviewMode): Promise<void>;
```

`switchTo` is the single entry point for every "become this mode" action. It replaces the current
event-subscription-only design for the *entry* path; the subscriptions stay as a safety net for events
dispatched by other code (a resumed session replaying records, a tool that dispatches directly), because
removing them would regress cases the events already cover.

## Conflict table

Derived from the existing rules plus what the sweep found missing:

| | plan | spec | swarm | tower |
| --- | --- | --- | --- | --- |
| **plan** | — | evict spec | **allowed** (R6) | evict tower |
| **spec** | evict plan | — | evict swarm | evict tower |
| **swarm** | **allowed** (R6) | evict spec | — | evict tower |
| **tower** | evict plan | evict spec | evict swarm | — |

Rows already correct in `modeMutexService.ts:26-41`: plan→tower, swarm→tower, tower→plan, tower→swarm.
Added by this change: plan↔spec, spec↔tower, spec↔swarm, and their inverses.

`plan` + `spec` is the pair the user reported. `spec` + `swarm` is included because both veto tools
(spec's `TaskStop`/`CronCreate`/`CronDelete` block at `specService.ts:227-236`, swarm's `Agent` veto at
`swarmService.ts:44-53`) and both constrain the model in incompatible ways.

## Restore-on-failure (R4)

```
switchTo(target):
  previous = activeMode()
  if previous === target: return
  if previous !== null: await leave(previous)      // durable exit/cancel events
  try:
    await enter(target)
  catch (error):
    if previous !== null: await enter(previous)    // best-effort restore
    throw error
```

The restore is best-effort: if re-entering `previous` also throws, the original error propagates and the
session ends with no mode, which is the honest outcome. Log/telemetry must record the restore attempt so
a stuck session is diagnosable.

`enter()` for each mode keeps its own precondition check. Because `switchTo` evicts first, that check
only fires on a genuine double-entry, which is correct.

## Entry points to rewire (R3)

| Entry point | Today | Change |
| --- | --- | --- |
| `EnterSpecMode` tool (`enterSpecModeTool.ts:25-39`) | `spec.enter()` directly | `mutex.switchTo('spec')` |
| `EnterPlanMode` tool (`enterPlanModeTool.ts:21-48`) | `plan.enter()` directly | `mutex.switchTo('plan')` |
| `setSpecMode` RPC (`sdk-rpc-client-v2.ts:1842-1851`) | `service.enter()/exit()` | `switchTo('spec')` / `leave('spec')` |
| `setPlanMode` RPC (`sdk-rpc-client-v2.ts:1832-1836`) | `enterPlan()/cancelPlan()` | `switchTo('plan')` / `leave('plan')` |
| `setTowerMode` RPC | tower service | `switchTo('tower')` / `leave('tower')` |
| swarm entry (`swarmService.enter`, `swarmService.ts:82-86`) | dispatches directly | route through the mutex (**careful**: the `AgentSwarm` tool and `/swarm` both call it) |
| `Shift+Tab` (`editor-keyboard.ts:275-291`) | `handlePlanToggle` | see below |
| startup flags (`kimi-tui.ts:1794-1798`) | `session.setPlanMode(true)` | unchanged call, new behaviour |

Swarm is the delicate one: `swarmService.enter()` is called by the `AgentSwarm` tool path, so routing it
through the mutex must not create a cycle (`swarmService` → mutex → `planService`/`specService` → …).
The mutex injects plan/spec/swarm/tower services; if `swarmService` injects the mutex back, that is a
cycle. **Resolve by keeping the mutex one-directional**: the mutex may call into the mode services, but
mode services must not call the mutex. Swarm's entry is rewired at its *callers* (the tool and the
slash command), not inside `swarmService.enter`.

## Shift+Tab (R7)

Decided semantics: **leave the exclusive mode if one is active; otherwise enter plan.**

`editor-keyboard.ts:275-291` becomes mode-aware:

```
const active = host.state.appState.specMode ? 'spec'
             : host.state.appState.swarmMode ? 'swarm'
             : host.state.appState.towerMode ? 'tower'
             : host.state.appState.planMode ? 'plan' : null;
if (active !== null) host.handleExclusiveModeLeave(active);
else host.handlePlanToggle(true);
```

Ordering matters: `plan` is checked last because it is the one that may legitimately pair with `swarm`.
If a session is in `plan` + `swarm`, `Shift+Tab` leaves `swarm` first (the narrower mode), then the next
press leaves `plan` — matching "leave the exclusive mode" rather than stranding the user.

The session-less path (`editor-keyboard.ts:282-289`) stays: lazily create the session, then apply.

`kimi-tui.ts:1166-1168` gains a sibling for the leave action; both route through the same RPC surface the
slash commands use, so there is one code path, not three.

## Indicators (R8)

`status-panel.ts:112-127` gains spec/swarm rows, fed from the same `AppState` fields the footer reads.
`commands/info.ts:185-186` passes them through. The `swarm-plan` combined badge (`footer.ts:593-598`)
is untouched.

`status-line-command.ts:17-28` (the `StatusLinePayload`) gains `specMode`, `swarmMode`, `towerMode`.
This is a **user-visible contract change** for `status_line.command` consumers: additive, so existing
commands keep working, but it should be called out in the changeset and in
`docs/{en,zh}/reference/` where the payload is documented.

The editor border (D5 / `kimi-tui.ts:2444-2448`) extends `highlighted` to include the other three modes,
using the same `primary` token — the comment at `:2449-2450` already describes plan as "primary", so no
new token is needed.

## `/spec` verifying the outcome (R9)

`handleSpecCommand` (`config.ts:167-202`) adopts the `/tower` pattern (`commands/tower.ts:71-83`):
after `setSpecMode`, re-read `session.getStatus()` and only report success if `status.specMode` matches
the request; otherwise set `appState` from the status and show the error. Same for `/swarm`
(`commands/swarm.ts:170`).

## Files touched

| File | Change |
| --- | --- |
| `packages/agent-core-v2/src/agent/modeMutex/modeMutex.ts` | non-empty interface (R2) |
| `packages/agent-core-v2/src/agent/modeMutex/modeMutexService.ts` | `activeMode` / `switchTo` / `leave`, extend conflict table |
| `packages/agent-core-v2/test/agent/modeMutex/modeMutex.test.ts` | new cases |
| `packages/agent-core-v2/src/features/spec/specService.ts` | telemetry `mode: 'spec'` (carried from prior spec) |
| `packages/agent-core-v2/src/features/{spec,plan}/tools/enter-*/enter*Tool.ts` | route through mutex |
| `packages/node-sdk/src/sdk-rpc-client-v2.ts:1832-1851` | route through mutex |
| `apps/kimi-code/src/tui/controllers/editor-keyboard.ts:275-291` | mode-aware Shift+Tab |
| `apps/kimi-code/src/tui/kimi-tui.ts:1166-1168`, `:2444-2448` | leave handler; border highlight |
| `apps/kimi-code/src/tui/commands/config.ts` | `/spec` outcome verification |
| `apps/kimi-code/src/tui/components/messages/status-panel.ts`, `commands/info.ts` | spec/swarm rows |
| `apps/kimi-code/src/tui/utils/status-line-command.ts`, `footer.ts` | payload fields |

## Alternatives considered

**A. Complete and expose the existing mutex (recommended).** Smallest diff, reuses a tested mechanism,
one owner of the rule.

**B. New `SessionModeService` as the prior spec proposed.** A clean new service, but leaves
`AgentModeMutexService` running its three subscriptions in parallel — two owners of exclusivity, which is
the same "duplicated policy that drifts" objection that rejected per-service guards last time. Only worth
it if the mutex's event-driven design is being removed outright.

**C. Per-service cross-checks** in each `enter()`. Rejected before and still rejected: creates DI cycles
and duplicates the policy four ways.

## Constraints

- `packages/agent-core-v2/docs/state-manifest.d.ts` / `wire-manifest.d.ts` are generated. This change
  adds no state and no event class, so regenerate and confirm a no-op rather than hand-editing.
- The model-facing prompts `enter-spec-mode.md` / `enter-plan-mode.md` describe what happens on entry;
  if entry now evicts another mode, the text must say so.
- The spec review gate (`specService.ts:220-225`) requires approval for `ExitSpecMode` unless permission
  is `auto`. A user-initiated `Shift+Tab` exit is not the model exiting — it must not be blocked by that
  review. Confirm the leave path used by the shortcut does not route through the tool-approval hook.
- Import boundaries: `check:boundaries` / `check:deep-imports` must stay green; the mutex lives under
  `agent/` and must not import from `apps/`.

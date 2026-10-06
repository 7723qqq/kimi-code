# Requirements — One active review mode, and indicators that tell the truth

## Goal

Two defects were fixed-by-design but never fixed-in-code: spec and plan modes stack, and `Shift+Tab`
only moves the plan half. A full sweep found the same shape in several more places — mutually exclusive
flags tracked independently, with indicators, guards, or shortcuts that only know about some of them.

This spec covers the whole class: make the exclusive modes actually exclusive, fix the shortcuts that
only reach half of a pair, and make the indicators reflect the real state. It supersedes
`specs/hercules-hellcat-dagger` (which specified only the plan/spec pair) and carries its decisions
forward.

Investigation evidence is the section below; every claim cites `file:line`.

## The mode inventory

Six flags describe "what mode is this agent in". They live in four different places and are consulted
by different layers.

| Flag | State | Entered by | Exclusivity enforced |
| --- | --- | --- | --- |
| plan | `planKey` (`packages/agent-core-v2/src/features/plan/planOps.ts:87`) | `EnterPlanMode` tool, `/plan`, `Shift+Tab` | vs tower only |
| spec | `specKey` (`packages/agent-core-v2/src/features/spec/specOps.ts:85`) | `EnterSpecMode` tool, `/spec` | **none anywhere** |
| swarm | `swarmKey` (`.../swarm/swarmOps.ts`) | `AgentSwarm` tool, `/swarm`, `/team` | vs tower only |
| tower | `towerKey` (`.../tower/towerOps.ts:47`) | `/tower` | exits plan + swarm on enter |
| goal | `goalOps.ts:14` | `/goal` | **none** |
| permission | `permissionPolicy/types.ts:6` | `/auto`, `/yolo`, `/swarm` | orthogonal by design |

The single existing enforcement point is `packages/agent-core-v2/src/agent/modeMutex/modeMutexService.ts:26-41`,
which reacts to `PlanModeEnter` / `SwarmModeEnter` / `TowerModeEnter`. It knows **three of the six** flags:
`spec` and `goal` do not appear in the file at all.

Crucially, `IAgentModeMutexService` (`modeMutex/modeMutex.ts:3-8`) is an **empty interface** and has **zero
production consumers** — grep for `IAgentModeMutexService` returns only its own declaration, its
implementation, and its test. The mutex runs because it is eagerly constructed at agent-scope activation
(`modeMutexService.ts:45-51`), not because anything asks it to. It is a private side-effect, not a
contract anyone can call.

## Defects

### D1 — spec and plan stack, deadlocking every write (high)

`specService.enter()` guards only itself (`specService.ts:110-112`); `planService.enter()` likewise
(`planService.ts:161-163`). Neither consults the other, and `modeMutexService.ts` does not know spec
exists. `/spec` (`apps/kimi-code/src/tui/commands/config.ts:167-202` → `sdk-rpc-client-v2.ts:1842-1851`)
and `/plan` (`config.ts:109-140` → `sdk-rpc-client-v2.ts:1832-1836`) each touch one flag only.

Consequence: plan's guard (`planService.ts:107-117`) permits writes to the plan file only; spec's guard
(`specService.ts:247-267`) permits writes inside the spec directory only. Both are registered
`onBeforeExecuteTool` hooks, so with both active the intersection is empty and **no file is writable**.
Reproduced live in the prior session: writing these documents was refused until plan mode was exited.
`footer.ts:593-605` renders both badges, so the state is visible but not explained.

### D2 — tower neither evicts nor is evicted by spec (high)

`TowerModeEnter` evicts plan and swarm (`modeMutexService.ts:36-41`) but not spec — spec is absent from
the file. Symmetrically, `SpecModeEnter` has no handler at all, so entering spec while tower is active
leaves tower running. The result is the same deadlock as D1 for tower's tool vetoes
(`towerService.ts:226-239`). This is the same omission as D1, one edge over.

### D3 — the exclusive-mode rule is not a real contract (medium)

`IAgentModeMutexService` is empty and unconsumed (above). No entry point can ask "may I switch modes?".
The rule exists as a side effect of event subscriptions, so any new entry point (a tool, an RPC, a host
integration) bypasses it by default — which is exactly how spec slipped through.

### D4 — `Shift+Tab` only reaches plan (high, the reported symptom)

`custom-editor.ts:563-566` matches `shift+tab` → `editor-keyboard.ts:275-291` computes
`next = !planMode` and calls `host.handlePlanToggle` → `kimi-tui.ts:1166-1168` → `handlePlanCommand`.
`specMode` is never read. With spec active, `/plan` refuses the no-op (`config.ts:134-137`), so the
shortcut appears to do nothing.

**Decided semantics** (user-selected): `Shift+Tab` leaves the exclusive mode when one is active,
otherwise enters plan. One press keeps its current feel, and the tip text
(`tui.chrome.tips.shiftTabPlanMode`, `tips.ts:55`) stays accurate.

### D5 — the editor border only signals plan (medium)

`kimi-tui.ts:2444-2448`: `const highlighted = this.state.appState.planMode || isBash || ...`. Spec,
swarm and tower produce no border change, so the editor gives no visual signal in three of the modes
that constrain what the model may write.

### D6 — `/status` and the status-line contract cannot see spec or swarm (medium)

`status-panel.ts:112-127` builds rows from `permission`, `planMode` and an optional `towerMode`; its
call site `commands/info.ts:185-186` passes exactly those. `/status` therefore prints
`Plan mode: off` while the footer shows a `spec` badge.

`utils/status-line-command.ts:17-28` exposes `permissionMode` and `planMode` only, fed from
`footer.ts:673-688`. A user's custom `status_line.command` cannot observe spec, swarm, tower or goal.

### D7 — `/spec on` can report success while nothing changed (medium)

`sdk-rpc-client-v2.ts:1842-1851` returns silently when the session is already in the requested state,
and `handleSpecCommand` (`config.ts:187-198`) then sets `appState.specMode = enabled` and shows
`specModeOn` **regardless of what the engine did**. `/tower` guards against exactly this by re-reading
`getStatus()` (`commands/tower.ts:71-83`) — the pattern exists and was not applied to `/spec`.

## Requirements

R1. **The six review modes partition into exclusive sets with one enforced rule.** plan, spec, swarm and
    tower are mutually exclusive *except* for the deliberate `plan` + `swarm` pair (see R6). Entering any
    of them evicts every conflicting one, from every entry point.

R2. **The rule is a callable contract, not a side effect.** Entry points must be able to ask to switch
    modes and get a synchronous, checkable answer — not rely on event-subscription timing. `IAgentModeMutexService`
    stops being empty.

R3. **Every entry point goes through it**: the `EnterPlanMode` / `EnterSpecMode` tools, `/plan`, `/spec`,
    `/swarm`, `/tower`, `Shift+Tab`, and the startup flags (`kimi-tui.ts:1794-1798`).

R4. **A failed entry leaves the session in the mode it started in.** If the target's `enter()` throws
    after the previous mode was evicted, the previous mode is restored. No entry point may leave the
    session with zero modes as a side effect of a failed switch.

R5. **Eviction is recorded durably**, so replay and resume reconstruct the same single mode. The existing
    `PlanModeExit` / `SpecModeExit` / `SpecModeCancel` events suffice; no new event class is needed.

R6. **`plan` + `swarm` stays a valid combination.** `footer.ts:593-598` already renders the combined
    `swarm-plan` badge and `modeMutexService.ts` deliberately does not evict across that pair. This
    spec preserves that; it does not extend exclusivity to it.

R7. **`Shift+Tab` uses the decided semantics**: cycle Plan and Spec — with neither active enter plan,
    otherwise advance one step (`plan → spec`, `spec → none`), evicting through the coordinator so each
    transition is durable. It must never leave the session in a stacked pair, and it must not enter or
    leave `swarm` or `tower` at all.
    *Superseded:* this read "leave the exclusive mode if one is active, otherwise enter plan" until
    2026-10-07. That rule made Spec → Plan take two presses, with the second appearing to undo the first.
    See `tasks.md` T5 and `progress.md`.

R8. **Indicators reflect the real state.** `/status` and the `status_line.command` payload expose the
    same mode set the footer does, so no viewer can claim `plan off` while spec is on.

R9. **`/spec`, `/swarm` and `/tower` confirm the mode actually took** before reporting success, following
    the `/tower` precedent (`commands/tower.ts:71-83`).

R10. **Each fix has a test that fails on the pre-change code**, at the layer where the rule lives.

## Audience

Maintainers of `packages/agent-core-v2` (`agent/modeMutex/`, the four mode features) and of
`apps/kimi-code/src/tui` (shortcut dispatch, slash commands, footer, status panel). Users see the
outcome as: pressing `Shift+Tab` or `/spec` puts the session in the mode they asked for, and the
indicator never lies.

## Boundaries

- The four modes keep separate state, services and guards. This makes them mutually aware; it does not
  merge them.
- `topic`/`btw`, `activeDialog`, and the input-mode copies are **out of scope** — see below. They are
  real but different classes of defect and are recorded in the design doc for a follow-up.
- Permission mode stays orthogonal. `/swarm`'s offer to raise permission (`commands/swarm.ts:104,132-146`)
  is existing intended behaviour and is not changed.

## Out of scope (found in the sweep, deliberately not fixed here)

These were surfaced by the same sweep and are recorded so they are not lost. Each is a separate defect
class with its own blast radius, and fixing them here would make this change unreviewable.

- **`activeDialog` is single-valued with six unowned writers** (`tui-state.ts:81-88`; writers at
  `dialog-host.ts:134,146,181,219,233`, `kimi-tui.ts:2673,2685,2728,2741`, `cache-hint-controller.ts:472,486`,
  `prompt-optimizer.ts:60-61,72`). No clear site checks ownership, so one dialog closing nulls the flag
  under another still mounted.
- **`/btw` silently destroys a running btw session** (`commands/btw.ts:14-18` +
  `controllers/btw-panel.ts:65-74,133-140`).
- **`goal` mode has no exclusivity** with any review mode.
- **`/team` turns swarm on as a side effect** (`commands/team.ts:92,97`) outside the mutex.
- **`swarmAgentVeto`** (`swarmService.ts:44-53`) denies `Agent` during a plan-scoped swarm while the
  footer advertises `swarm-plan` as a supported state — a messaging question more than a bug.
- The `inputMode` triplication (`types.ts:44`, `custom-editor.ts:177`, `types.ts:331`).

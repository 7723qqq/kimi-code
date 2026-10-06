# Progress

## Investigation — complete

Both defects located and explained. The full evidence trail is in `requirements.md`
("Observed behaviour"). Summary:

**Why spec and plan stack.** They are two independent states with no mutual awareness.
`planKey` (`packages/agent-core-v2/src/features/plan/planOps.ts:87`) and `specKey`
(`packages/agent-core-v2/src/features/spec/specOps.ts:85`) are separate; each `enter()` checks only its
own precondition (`specService.ts:110-112`, `planService.ts:161-163`); neither `/plan`
(`apps/kimi-code/src/tui/commands/config.ts:109-140` → `sdk-rpc-client-v2.ts:1832-1836`) nor `/spec`
(`config.ts:167-202` → `sdk-rpc-client-v2.ts:1842-1851`) touches the other mode; and `footer.ts:593-605`
renders the two badges independently, so the stacking is visible. Spec mode even reports itself to
telemetry as `mode: 'plan'` (`specService.ts:92,120`).

The cost is not cosmetic: plan mode's guard (`planService.ts:107-117`) and spec mode's guard
(`specService.ts:238-267`) allow disjoint write sets, so with both active **no file is writable at
all** — which blocked writing these very documents until plan mode was exited. Reproduced live.

**Why Shift+Tab cannot switch.** `custom-editor.ts:563-566` → `editor-keyboard.ts:275-291` reads and
writes only `planMode` (`next = !planMode` → `handlePlanToggle`), then `kimi-tui.ts:1166-1168` routes to
`handlePlanCommand`. `specMode` is never read. With spec mode active the shortcut can only flip the
stacked plan half, and `/plan` refuses a no-op (`config.ts:134-137`).

## Approach — decided

**A: session-level mode coordinator** (user-selected at spec exit). A new service owning the
"which exclusive mode is active" rule; `setPlanMode` / `setSpecMode` and both `Enter*` tools route
through it. Rejected B (per-service cross-calls: DI cycle, duplicated policy) and C (RPC-facade only:
misses the tool entry points).

## Tasks

- [ ] T1 — spec mode reports `mode: 'spec'` in telemetry (R4)
- [ ] T2 — add the session mode coordinator (R1, R3, R5)
- [ ] T3 — route all entry points through the coordinator (R1, R5)
- [ ] T4 — make Shift+Tab mode-aware (R2)
- [ ] T5 — verify indicator and guards agree (R6)
- [ ] T6 — changeset and docs

## Status

**Superseded by `specs/archangel-quake-dagger`. No code was written from this spec's design.**

Spec approved; the request that opened this session was to locate the code and explain the cause, which
is done above. Implementation of T1–T6 was never started **from this document**, because the sweep that
followed this spec found the work belonged in a larger change.

`archangel-quake-dagger` supersedes this spec explicitly (`requirements.md:10-11`, `design.md:5`) and
carries its decisions forward. Approach A as designed here — a **new** `SessionModeService` in
`packages/agent-core-v2/src/session/mode/` — was **rejected** there: `AgentModeMutexService` already
implemented the same rule for three of the flags and was already registered and tested, so completing
and exposing it was the smaller change. Verified against the tree: that directory does not exist and
`SessionModeService` appears nowhere in the repo.

Where this spec's requirements were met, they were met by `archangel-quake-dagger`'s tasks, not these:

| This spec | Met by | Landing point |
| --- | --- | --- |
| T1 — spec reports `mode: 'spec'` (R4) | archangel T8 | `features/spec/specService.ts:120` |
| T2 — a mode coordinator (R1, R3, R5) | archangel T1–T3 | `agent/modeMutex/modeMutex.ts` + `modeMutexService.ts` (the existing mutex, completed) |
| T3 — every entry point routed (R1, R5) | archangel T4 | the two `Enter*` tools, `setPlanMode` / `setSpecMode` / `setSwarmMode` / `setTowerMode` |
| T4 — `Shift+Tab` mode-aware (R2) | archangel T5 | `apps/kimi-code/src/tui/controllers/editor-keyboard.ts` |
| T5 — indicators and guards agree (R6) | archangel T6 | `/status` rows, `status_line.command` payload, editor border highlight |
| T6 — changeset and docs | archangel T9 | `.changeset/exclusive-review-modes.md`, `docs/{en,zh}/reference/slash-commands.md` |

R6 ("the footer and the status panel never show `plan` and `spec` as simultaneously active") is met,
but note that `plan` + `swarm` deliberately remains a legal pair — this spec's requirement was written
for the plan/spec pair only and was not extended.

The `Shift+Tab` semantics question this spec left open ("Shift+Tab target mode" in `design.md`) was
settled in `archangel-quake-dagger` and has since changed again; see that spec's `progress.md` for the
current `none → plan → spec → none` cycle. Do not read the recommendation quoted below as the shipped
behaviour.

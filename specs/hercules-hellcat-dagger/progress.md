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

Spec approved; no code changes made yet. The request that opened this session was to locate the code
and explain the cause, which is done above. Implementation of T1–T6 has not been started.

Approach A was selected for the coordinator placement. The `Shift+Tab` target-mode choice in
`design.md` ("Shift+Tab target mode") was **not** separately decided — the recommendation there is
"leave the exclusive mode when either is on, otherwise enter plan". T4 depends on that choice.

# Progress

## Investigation — complete

### D1 — spec and plan stack, deadlocking every write

`specKey` (`packages/agent-core-v2/src/features/spec/specOps.ts:85`) and `planKey`
(`.../plan/planOps.ts:87`) are separate states. Each `enter()` checks only its own precondition
(`specService.ts:110-112`, `planService.ts:161-163`). `modeMutexService.ts` does not contain the string
`spec` at all. `footer.ts:593-605` renders both badges.

The two guards are independent `onBeforeExecuteTool` hooks — plan permits only the plan file
(`planService.ts:107-117`), spec permits only the spec directory (`specService.ts:238-267`) — so both
active means **no file is writable**. Reproduced live: writing these documents was refused until plan
mode was exited.

### D2 — tower neither evicts nor is evicted by spec

`TowerModeEnter` evicts plan and swarm (`modeMutexService.ts:36-41`) but not spec; `SpecModeEnter` had
no handler at all.

### D3 — the exclusive-mode rule was not a contract

`IAgentModeMutexService` (`agent/modeMutex/modeMutex.ts:3-8`) was an **empty interface with zero
production consumers** — grep matched only its own declaration, implementation and test. The rule ran
as a side effect of eager construction at agent-scope activation (`modeMutexService.ts:45-51`).

### D4 — Shift+Tab only reached plan

`custom-editor.ts:563-566` → `editor-keyboard.ts:275-291` computed `next = !planMode` and called
`handlePlanToggle` → `kimi-tui.ts:1166-1168` → `handlePlanCommand`. `specMode` was never read.

### D5 — the editor border only signalled plan

`kimi-tui.ts:2444-2448` read `planMode` only, **and** `setAppState` (`:1547`) re-highlighted only when
`'planMode' in patch` — a second half of the same defect: spec/swarm/tower switches did not refresh the
border at all.

### D6 — `/status` and the status-line contract could not see spec or swarm

`status-panel.ts:112-127` built rows from permission/plan/tower only. `status-line-command.ts:17-28`
exposed `permissionMode` and `planMode` only.

### D7 — `/spec` could report success while nothing changed

`handleSpecCommand` set `appState.specMode = enabled` and showed `specModeOn` regardless of what the
engine did. `/tower` already guarded against this (`commands/tower.ts:71-83`); `/spec` did not.

## Approach — decided and implemented

**A: complete and expose the existing mutex** (user-selected). Not a new service: `AgentModeMutexService`
already implemented the rule for 3 of 6 flags and already had 6 passing tests.

## Tasks

- [x] **T1** — mutex contract: `ExclusiveReviewMode`, `activeMode()`, `switchTo()`, `leave()`.
      `modeMutex.test.ts`: 6 pre-existing + 15 new = **21 pass**; 15 failed before the change.
- [x] **T2** — conflict table extended to plan↔spec, spec↔tower, spec↔swarm and inverses.
      `plan`+`swarm` stays legal (explicit test).
- [x] **T3** — `switchTo` restores the previous mode when the target's `enter()` throws; the original
      error propagates even if the restore also fails.
- [x] **T4** — every entry point routed through the mutex: both `Enter*` tools, `setPlanMode`,
      `setSpecMode`, `setSwarmMode`, `setTowerMode`, and the `AgentSwarm` tool. `modeEntryTools.test.ts`
      (6 tests) plus 2 new harness-backed cases in `packages/node-sdk/test/session-spec.test.ts`.
      Verified red: with the source stashed, both eviction tests fail.
- [x] **T5** — `Shift+Tab` is mode-aware. **Semantics changed after this work (2026-10-07).** As
      shipped here it was "leave the active exclusive mode, else enter plan; `swarm` is peeled before
      `plan` when both are set" — 4 tests failed before, all 39 passed after. In use that proved
      defective: leaving and entering were separate presses, so Spec → Plan took two presses and the
      second *looked like it undid the first*. It is now a cycle, `none → plan → spec → none`, one
      transition per press, implemented in `editor-keyboard.ts` by `nextReviewMode()` over a
      `ReviewCycleState`. **Swarm and Tower are no longer part of the shortcut at all** — not entered,
      not left, not peeled; their paths are `/swarm` and `/tower` only. That isolation is structural:
      `ReviewCycleState` carries only `planMode`/`specMode`, `reviewCycleState()` returns `null` while
      swarm or tower is active (the press is a no-op), and `ActiveExclusiveMode` is `'plan' | 'spec'`,
      so the former `handleSwarmCommand('off')` / `handleTowerCommand('off')` branches no longer
      compile (TS2678) and were removed. Tests now assert the resulting state rather than that a
      handler was called — the original `expect(handleExclusiveModeLeave).toHaveBeenCalledWith('spec')`
      passed even while the feature misbehaved. Isolation verified red: dropping the swarm/tower guard
      from `reviewCycleState()` fails 5 cases.
- [x] **T6** — indicators: spec/swarm rows in `/status`, `specMode`/`swarmMode`/`towerMode` in the
      `status_line.command` payload, and the border highlight for all four modes (plus the `setAppState`
      refresh fix). New: `status-panel.test.ts` +2, `editor-border-highlight.test.ts` (6),
      `footer-status-line.test.ts` +1.
- [x] **T7** — `/spec` and `/swarm` re-read status before reporting success, following `/tower`.
      `handleSpecCommand` was not exported from the barrel at all, which is why nothing tested it.
      New `commands/spec.test.ts` (4) and `swarm.test.ts` +2.
- [x] **T8** — spec telemetry reports `mode: 'spec'`, not `'plan'`. `AgentTelemetryContext.mode` widened
      to `'agent' | 'plan' | 'spec'`.
- [x] **T9** — changeset (`.changeset/exclusive-review-modes.md`), docs (`docs/{en,zh}/reference/slash-commands.md`
      exclusivity note, `docs/{en,zh}/configuration/config-files.md` payload fields), locale labels
      (`specModeLabel` / `swarmModeLabel`). `bun scripts/check-locale-keys.mjs` passes: 1700 kimi-code keys.
- [x] **T10** — verification.
      - `tsc --noEmit` clean for `packages/agent-core-v2`, `apps/kimi-code`, `packages/node-sdk`.
      - Focused suites green: modeMutex 21, modeEntryTools 6, plan 26, spec 51, swarm 98,
        node-sdk, editor-keyboard 39, status-panel 7, editor-border-highlight 6, footer-status-line 17,
        commands/spec 4, commands/swarm 19.
      - `bunx vitest run` (whole repo): **18127 passed, 2 failed**, 81 skipped, 1 todo.
      - End-to-end named check (`packages/node-sdk/test/session-mode-exclusivity.test.ts`): activate
        plan mode, then spec mode, then **write a real file into the spec directory** and read the
        stage back. This is the D1 deadlock exercised for real, not just the status flags. Verified red:
        with the source changes stashed both cases fail, with them restored both pass.
      - Manifest regeneration: **wire manifest unchanged** (no new event classes). The **state manifest
        did change**, by two lines adding `lastTransition?: 'cancel' | 'exit'` to the `spec` and `plan`
        entries. That is **pre-existing drift**, not this change: the field already exists in
        `specOps.ts` / `planOps.ts` in the working tree from earlier uncommitted work, and the generated
        file had not been regenerated. This change adds no state of its own. The design doc's "should be
        a no-op" assumption was wrong for that reason, not because the design leaked state.
      - `oxlint --type-aware` on the touched files: **0 errors**. The warnings reported are all in
        pre-existing lines (verified against `HEAD`), not in added code.
      - `bun scripts/check-locale-keys.mjs` passes.

### The 2 MCP failures — root cause found and fixed (unrelated to the mode work)

`test/mcpCore/connection-manager.test.ts` ("invalidates stored OAuth tokens when a runtime 401 fails the
refresh") and `test/mcpCore/oauth/callback-server.test.ts` ("rejects an in-flight completion when the
authorization flow is cancelled"), both reported as 15 s timeouts.

**They are not this change:** neither the tests nor the code under them is modified by the mode work, and
they import none of its files.

**The real root cause is in `mcpCore/oauth/callback-server.ts`, and it is a ~3 s close latency.**

`closeServer()` (`:127-138`) only calls `server.close()`. That stops accepting new connections, but
whether its callback waits for connections still open is **runtime-defined**, and the request handler had
already completed the flow, leaving an idle keep-alive socket behind:

- **Node waits.** `server.close()`'s callback fires only once every connection has ended. The idle
  keep-alive socket is held by the client (undici), which tears it down after its own idle timeout, so
  the callback is deferred by that much.
- **Where 3 s comes from, computed from source, not guessed.** The server advertises
  `Keep-Alive: timeout=5` (Node's `server.keepAliveTimeout = 5000`). undici converts it at
  `undici/lib/dispatcher/client-h1.js:685-688`:
  `Math.min(keepAliveTimeout - kKeepAliveTimeoutThreshold, kKeepAliveMaxTimeout)` with
  `kKeepAliveTimeoutThreshold = 2000` and `kKeepAliveMaxTimeout = 600000`
  (`undici/lib/dispatcher/client.js:307-308`) → `Math.min(5000 - 2000, 600000)` = **3000 ms**. That value
  is armed at `client-h1.js:1120` (`socket[kParser].setTimeout(..., TIMEOUT_KEEP_ALIVE)`) and fires at
  `:851-852` (`util.destroy(socket, new InformationalError('socket idle timeout'))`). The client drops the
  socket, the server sees the connection end, and the callback finally runs. Both ends decide half of the
  number, which is why it is not the intuitive 5000.
- **The fix is runtime-independent.** `callback-server.ts` now tracks its sockets
  (`server.on('connection', ...)`) and destroys them in `closeServer()`, so close no longer depends on
  either runtime's drain semantics — the same code closes promptly on both. Measured:
  `bunx vitest` (Node) went **~3000 ms → ~26 ms**; `bun --bun run test` **~0 ms** either way (Bun's
  `server.close()` never waited). The whole `callback-server.test.ts` file went **6321 ms → 300 ms**.
  A regression test pins it: `closes without waiting for the keep-alive socket to drain` asserts
  `close()` returns in under 1 s — verified red (3007 ms) with the destroy removed, green with it.

**Verification (canonical command, `bun --bun run test`):** `Test Files 1006 passed | 11 skipped`,
`Tests 18132 passed | 81 skipped | 1 todo` — **0 failures**. Typecheck clean for `agent-core-v2`,
`node-sdk`, and `apps/kimi-code`; `oxlint --type-aware` on the two changed files reports 0 errors.

**Why it only surfaced in a whole-repo run:** each file carried two 3 s waits, which fit inside the
tests' own `15000` budget in isolation; under full-suite scheduling the file's total crossed it.

### Runtime note (affects how these numbers should be read)

`CONTRIBUTING.md:64` states the canonical test command is `bun --bun run test` (vitest on the **Bun**
runtime), and that `bunx vitest` on Node "has been observed to pass while `bun --bun run test` fails on
the same code". The earlier verification in this spec used `bunx vitest` (Node). The 3 s close latency is
a **Node-runtime** artifact; on Bun the same code was already fast. The fix makes the timing correct on
both, which is what the shipped runtime (`DEVELOP.md:39`, Bun ≥ 1.4 for build/test/release) requires.

### Test fixtures this change had to update (not regressions)

Changing the `EnterPlanMode` / `EnterSpecMode` tool descriptions changes the serialized tool list, which
shifts two things that tests pin literally:

- 4 `llm.tools_snapshot` wire-log snapshots (updated with `vitest -u`).
- 4 token-count literals in `fullCompaction.test.ts` (`6_599 → 6_656`, `6_606 → 6_663`,
  `6_623 → 6_680`) — a consistent +57/ +57 delta, matching the added prompt text.

These were confirmed as consequences of the description change by observing the actual-vs-expected diff,
not by assuming.

## Status

T1–T10 complete. All suites green under the canonical Bun command (`bun --bun run test`); the two MCP
failures were traced to a runtime-specific close latency in `callback-server.ts` and fixed there.

## Notes for review

- The mutex is deliberately one-directional: it injects the four mode services; no mode service injects
  it. Swarm entry was rewired at its *callers* (the `AgentSwarm` tool, `setSwarmMode`), not inside
  `swarmService.enter`, to avoid a DI cycle.
- `setTowerMode` does not use `switchTo` because `tower.enter()` returns a result rather than throwing;
  it leaves the conflicting modes explicitly and then reports the failure, so a refused tower entry
  cannot leave the session mode-less.
- Deliberately out of scope, recorded in `requirements.md`: the `activeDialog` single-slot defect, `/btw`
  destroying a running session, goal-mode exclusivity, `/team` bypassing the mutex. Separate classes,
  separate blast radius.

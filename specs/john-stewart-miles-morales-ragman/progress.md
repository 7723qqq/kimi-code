# Spec Mode Hardening — Progress

Selected approach: **A** — fail closed when containment cannot be resolved (Choice 1A), and
`clear()` deletes the documents but keeps the directory (Choice 2A).

Three rounds of work happened here. Round 1 hardened the guard and exit flow (F1–F7).
Round 2 aligned behaviour with the prompt templates (`stage` consumer, `progress.md`,
`reenter` wording, `enter()` rollback) and repaired two hosts spec mode had broken.
Round 3 was a re-audit that found five claims from round 2 did not hold, plus a third broken
host; its repairs are listed under "Round 3".

## Status: complete, with the gaps below recorded

### Round 1 — guard and exit flow

| Task | Status | Notes |
|------|--------|-------|
| 0 — Resolve F7 (non-file write accesses) | done | `kind: 'all'` exists and is the executor's **default** at `toolExecutorService.ts:438`; `Team`/`AgentSwarm` declare it. The old guard filtered it out and allowed it. Now denied. |
| 1 — Realpath-aware containment (F1) | done | `isWithinDirectoryResolved` in `tool/path-access.ts`; guard is async via `waitUntil`. |
| 2 — Telemetry: one submitted, honest resolved (F2, F6) | done | Review-path emission deleted; `file_count` counts non-empty docs; auto path emits `approved_without_review`. |
| 3 — Read documents once per exit (F3) | done | `documentData()` added; `recordRevision(data?)` accepts pre-read data. |
| 4 — `clear()` means cleared (F4) | done | Removes the documents and `progress.md`; keeps the directory. |
| 5 — Distinguish exit from cancel (F5) | done | `lastTransition` on `SpecState`; duplicated handler bodies merged. |
| 6 — Close out | done | Superseded by rounds 2–3; see below. |

### Round 2 — alignment with the prompt templates

| Item | Status | Notes |
|------|--------|-------|
| TUI never reflected spec mode live | done | `session-event-handler.ts` patched plan/swarm/tower but dropped `specMode`; a model-started spec left the indicator stale. One line. |
| `stage` had no consumer | done | `SessionStatus.specStage` + `getStatus` mapping + footer badge (`spec:tasks`). |
| `progress.md` had no consumer | **half done in round 2** | Read added to `status()`; the outward mapping was missed. Completed in round 3 (R4). |
| `enter()` rollback was dead code | done | Flag was set after the last fallible statement, so it never fired. |
| `reenter` wording presumed documents exist | done | Reworded to "may already contain documents". |
| vscode `spec_review` missing (TS2366) | done | Case added — but with a `default` that disabled the guard; corrected in round 3 (R2). |
| vis missing the four spec wire records | done | `specOps` exported from the barrel, union extended, projector switch covered. |

### Round 3 — re-audit and repair

| Item | Status | Notes |
|------|--------|-------|
| R2 — vscode exhaustiveness guard | done | The `default` I added turned a future missing `kind` from a compile error into a silent fallback. Replaced with a `never` gate. |
| R3 — spec pipeline had no test | done | `packages/node-sdk/test/session-spec.test.ts` drives a real session; breaking `getStatus`'s `specStage` fails it. |
| R4 — `progress` never left the engine | done | `SpecSnapshot.progress` added and mapped in `getSpec`. |
| R5 — acp-server `spec_review` unhandled | done | `spec_*` option namespace mirroring `plan_*`; without it a spec review fell to the canonical options, which cannot express "Revise". |
| R1 — root typecheck omitted kimi-web | done | Added to the root script; coverage documented in both `CONTRIBUTING` files. |
| R6 — spec mode had no user docs | done | `tools.md` (section + table rows) and `slash-commands.md` (`/spec`) in both locales. |
| R7 — this file and the changeset | done | This document. |

## Deviation from the approved design (round 1)

`design.md` said an unresolvable path fails closed unconditionally. That broke the
legitimate case of writing a document that does not exist yet, which is the normal first
write in spec mode: `nodeRealpath` throws ENOENT for any path not yet on disk. The fail-closed
rule was therefore scoped to **the base directory** being unresolvable. A not-yet-existing
candidate resolves its deepest existing ancestor and is judged normally. Symlink escapes are
still denied — confirmed by test, under both a real host filesystem and the stub.

## Disposition of findings

| Finding | Disposition |
|---------|-------------|
| F1 symlink escape | Fixed. `isWithinDirectoryResolved` + `waitUntil` guard. |
| F2 duplicate `spec_submitted` | Fixed. One emission, real `file_count`. |
| F3 three reads per exit | Fixed. One read. Test verified to fail when reverted. |
| F4 `clear()` wrote empty strings | Fixed. Documents removed. |
| F5 exit/cancel identical in replay | Fixed. `lastTransition` recorded and in the state manifest. |
| F6 five `spec_resolved` sites, dishonest `approved` | Fixed. Auto path reports `approved_without_review`. |
| F7 non-file access kinds | **Real and worse than assumed.** `ToolAccesses.all()` is the executor's default when a tool declares no accesses, and was silently allowed. Now denied. |

## Claims from round 2 that did not hold

Recorded because the pattern behind them is the useful part: each came from acting on a
remembered or assumed version of the code rather than the file in front of me.

| Claim | Reality |
|-------|---------|
| "全仓库类型检查 0 错误" | The root script omits `apps/kimi-web` (excluded from workspaces) and `docs`. I read only the last 14 lines. Fixed in R1. |
| "端到端可用" | `specStage` and `progress` had **no** test anywhere on their pipelines; only the endpoints were asserted. Fixed in R3/R4. |
| "`progress.md` 有了消费方" | The read existed; `getSpec` never mapped it, so nothing outside the engine could see it. Fixed in R4. |
| "加 `default` 的理由站得住" | It does not: it converted a future missing `kind` from a compile error into a silent fallback. Fixed in R2. |
| "完整修正已完成" | `acp-server` had the same `spec_review` gap and was never checked. Fixed in R5. |
| "spec 模式无需文档" (implicit) | `/spec`, both tools and the write guard were absent from `docs/`. Fixed in R6. |

Also reversed during round 2, with no residue: the `sparse` path was never missing (I read a
stale copy); `reenter` does not use a state bit as a proxy for a disk fact (only its wording
was wrong); `SpecState.stage` does not exist (stage is derived; the edit was reverted); the
kap-server schema change (T3b) was unnecessary and was reverted.

## Verification (round 3)

Every line below is a command that was run; see the round-3 report for the quoted output.

- `bun run typecheck` — now includes `apps/kimi-web`; all workspaces green.
- `bunx vitest run packages/agent-core-v2 apps/kimi-code/test/tui`
- `bunx vitest run --config apps/vscode/vitest.config.ts`
- `(cd apps/vis/server && bun run test)`
- `(cd packages/acp-server && bun run test)`
- `packages/node-sdk` suite including the new `session-spec.test.ts`
- `bun scripts/check-locale-keys.mjs` — consistent.
- `cd docs && bun run build` — the four edited pages contribute no dead links. Two dead links
  remain in `docs/DEVELOP.md` (`./config.md` does not exist); confirmed pre-existing by
  stashing all changes and reproducing the identical failure.

## Known gaps, not fixed

| Gap | Why it is left |
|-----|----------------|
| `features/plan/planOps.ts` had the same exit/cancel duplication this work removed from `specOps.ts`. | **Fixed** in the round-4 follow-up: `lastTransition` added, duplicated handler bodies merged, and the no-op identity preserved. |
| `docs/DEVELOP.md` had two dead links to `./config.md`. | **Fixed**: the typography example now points at `docs/index.md`, and `bun run build:docs` was added so this cannot regress silently. |
| A deep-import → package-barrel refactor sits uncommitted in the working tree (see below). | Someone else's in-progress change. This work avoided its hunks; it was mistaken for my own output in round-2 summaries, which is why the file lists there looked wrong. |
| vscode and vis now have exhaustiveness gates, but `apps/kimi-web` treats `display` as `unknown` and falls back to generic by design — a new display kind will not fail its typecheck. | That is a deliberate contract; noted so it is not mistaken for a gap later. |

## How to verify this work (read before trusting any suite result)

**Use `bun --bun run test`, not `bunx vitest`.** The `--bun` flag runs vitest on the Bun
runtime; `bunx vitest` runs it on Node, and the two disagree. Round 3's report claimed a green
suite from `bunx vitest`, which is not what CI runs (`.github/workflows/ci.yml` uses
`bun --bun run test --shard=N/5`) and which hid a real failure. The canonical command and this
caveat are now recorded in both `CONTRIBUTING` files.

## The uncommitted barrel refactor in the working tree

Scope: **40 files** rewrite `@moonshot-ai/agent-core-v2/<deep/path>` imports to the package
entry point, across `apps/kimi-code`, `apps/kimi-inspect`, `apps/vis/server`,
`packages/acp-server`, `packages/kap-server`, `packages/klient`, `packages/migration-legacy`
and others.

Eight of those files are also touched by this work. The hunks are **disjoint** in every case —
the refactor's hunks are import-specifier lines only, while this work adds symbols or test
blocks:

| File | Refactor hunks | This work |
|------|----------------|-----------|
| `packages/acp-server/src/events-map.ts` | import lines 13, 18, 24 | not touched |
| `packages/acp-server/src/session.ts` | import lines | not touched |
| `packages/acp-server/test/approval.test.ts` | import lines 14, 21 | spec_review tests at 79+, 194+ |
| `apps/vis/server/src/lib/agent-record-types.ts` | import block | the four spec record unions |
| `packages/kap-server/src/protocol/events-zod.ts` | 11 import hunks | not touched (the `specStage` attempt was reverted) |
| `packages/kap-server/src/services/transcript/coreEventMap.ts` | import hunks | not touched |
| `packages/kap-server/src/transport/ws/v1/events.ts` | import hunks | not touched |
| `apps/kimi-inspect/src/channel/channel.ts` | import hunks | not touched |

Rule for anyone continuing: never edit a hunk whose only change is an import specifier.

# Progress

Approach selected at ExitSpecMode: fix the call sites, add `tui.slashCommands.spec`, extend the
coverage check. The other two options (only the two reported keys; defer the locale addition) were not
executed.

## Result

`scan.mjs` over `apps/kimi-code/src` against the leaf keys of
`apps/kimi-code/src/i18n/locales/en.ts`: **20 missing → 0 missing**. `check-t-call-coverage.mjs` now
reports `✓ kimi-code: 371 files, 1448 unique t() keys, 1701 locale keys` and is a CI step.

## Tasks

| Task | Status | Evidence |
|---|---|---|
| 1 — reproduce via scan | done | `scan: 1700 leaf keys, 20 missing`, exactly the 20 keys the spec listed |
| 2 — 15 `tui.dialogs` call sites | done | 5 in `prompt-optimize-panel.ts`/`prompt-optimizer.ts`, 10 across `msys2-prompt.ts`/`kimi-tui.ts`; grep shows only `tui.dialogs.*` |
| 3 — `toolCall.failed` | done, **approach corrected** | see Correction 1 |
| 4 — `tui.slashCommands.spec` | done | added to `en.ts`/`zh.ts` beside `tui.slashCommands.plan`; JSON regenerated |
| 5 — test mocks | done | 10 mock entries repointed; `vitest run` on both files: 12/12 pass |
| 6 — coverage check + CI | done | new `SOURCES` list; `check:t-coverage` in `package.json:51`; step in `ci.yml` |
| 7 — optional orphan key | not executed | not chosen at ExitSpecMode |
| 8 — full verification | done | see below |
| 9 — optimizer review | done | `prompt-optimizer-review.md` |

## Corrections to the spec's own findings

Two claims in `requirements.md` and `design.md` were wrong and were corrected against the tree rather
than carried forward. Both documents still contain the original wording; this is the record of what
actually held.

**1. Group B was not a namespace confusion.** The spec said `tui.messages.toolCall.failed` belonged at
`tui.dialogs.toolCall.failed`. There is no `toolCall` block under `tui.dialogs` at all — the original
claim came from a lexical indentation walk that mislabelled the parent, and the "verification" was a
scan run *after* my edit, which only re-reported the still-missing key. The branch at
`apps/kimi-code/src/tui/components/messages/tool-call.ts:2054` is `formatPhaseChip()`'s `case 'failed'`,
a sibling of `'● queued'`, `'↻ running'` and `'✓ done'`. The block already holds the right label:
`tui.messages.toolCall.phaseFailed` (`"failed"` / `"失败"`, `en.ts:1709`). Fixed by pointing at it, so
**no locale entry was added for this key** and requirement R6 holds. No new key was invented, and
`failedStatus` (`"{{count}} failed"`, a count label) was correctly not used.

**2. `tui.slashCommands.spec` insertion point.** The design said to add it beside the `plan` entry in
`tui.slashCommands`. The `spec:` line the earlier commit introduced sits in `cli.optionDescriptions`
(`en.ts:43`) — a different block with different neighbours. The insertion targeted
`tui.slashCommands.plan` directly (`en.ts:238`, `zh.ts:231`), which is the block `registry.ts:223`
reads.

## Verification (all actually run)

- `bun run typecheck` — every package exit 0, no errors.
- `bun run lint` — **0 errors**, 11161 warnings (pre-existing). One error appeared during the run and
  was traced to a throwaway scan script of mine being linted as part of the tree; the script was
  deleted, and a `git stash` comparison confirmed the 0-error baseline is the repo's own.
- `bun vitest run apps/kimi-code/test/tui` — 179 files, 3080 tests, all pass.
- `bun run check:t-coverage` — exit 0; with a fabricated key injected it exits 1 and prints the key and
  file, and returns to 0 when reverted.
- `bun scripts/check-locale-keys.mjs` — exit 0, `kimi-code: 1701 keys match`.
- `bun scripts/check-locale-placeholders.cjs` — exit 0.
- `bun scripts/generate-locale-json.cjs` then `git diff --exit-code -- '**/locales/*.json'` — the
  remaining diff is the working tree's pre-existing uncommitted `shiftTabPlanMode` / `specModeLabel` /
  `swarmModeLabel` edits, which regeneration correctly synchronised into JSON. Not mine, not reverted.
- Changeset `.changeset/tui-missing-translation-keys.md`, `@moonshot-ai/kimi-code` at patch.

## Notes for the reader

- The working tree already contained unrelated uncommitted changes when this work started (the
  Shift-Tab mode-cycle work: `en.ts`/`zh.ts`, several `tui/` files, docs, and
  `.changeset/shift-tab-mode-cycle.md`). My edits are additive to that state; `git diff` mixes the two.
- `scan.mjs` was deleted after Task 1 to keep `bun run lint` at 0 errors — lint covers `specs/`, and the
  script's unscoped `.sort()` tripped `require-array-sort-compare`. Task 1's scan is reproduced by
  `check:t-coverage`, which covers the same ground.

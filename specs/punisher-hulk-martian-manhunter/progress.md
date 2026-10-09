# Progress — DeepSeek adaptation convergences

Commits, oldest first:

| # | Commit | Task |
|---|---|---|
| 1 | `0089abd2fe` | pre-existing: #2 dropped dead fields |
| 2 | `28acab547c` | pre-existing: #5 family-table boundary comment |
| 3 | pre-existing | #3 shared curated gate |
| 4 | `25c3991657` | A1 — usage module owns OpenAI usage semantics |
| 5 | `2694a6b808` | A2 — consistency rule tests |
| 6 | `fbf7457017` | A3 — changeset A, records the v2/kosong divergence |
| 7 | `6d18d56048` | B1 — adaptation kind by directory |
| 8 | `5dc7f27dad` | B3 — changeset B |

## A1 — usage module

Added `src/human/llm/requester/bases/openai/usage.ts` with `readOpenAICacheFields`
(recognition + consistency rule) and `parseOpenAIUsage` (normalisation).
`format.ts:126` became `export { parseOpenAIUsage }`, importing from `./usage`, so
`requester.ts:37,168` needed no change.

Two cleanups the move forced: `TokenUsage` and `OpenAIRawUsage` imports in `format.ts`
became unused (oxlint caught both) and were removed.

Also worth noting: I briefly deleted the `OpenAIRequestParams` interface header with a
bad edit and restored it; the final `git diff` of `format.ts` shows only the intended
hunks plus pre-existing working-tree changes.

## A2 — tests

Three new cases in `deepseek-live-usage.test.ts` (6 total, all pass):
- `hit + miss > prompt_tokens` → falls back (`inputCacheRead: 0, inputOther: 100`)
- fallback uses the OpenAI count when present (`inputCacheRead: 40, inputOther: 60`)
- `hit + miss < prompt_tokens` → no fallback (`inputCacheRead: 10, inputOther: 20`)

The real capture `1792 + 219 === 2011` still passes through untouched.

## B0 — build gate (blocking)

Ran a real `tsdown` build with a nested `probe/sub/probe.md`. It appeared at
`dist/model-adaptations/probe/sub/probe.md`. **tsdown `copy` recurses.** Probe removed.
Q7 fallback not needed.

## B1 — directory split

`curated/deepseek.md`; `measured/{deepseek-v3,claude-3.5-sonnet,gpt-4o}.md`.
`LoadAdaptationInput` gained `kind`, `adaptationDirectoryCandidates` appends it,
`loadCuratedAdaptation` passes `'curated'`, `profileService.ts:913` passes `'measured'`.

**One test I wrote was wrong, and the code was right.** I asserted
`loadCuratedAdaptation('deepseek-v3')` returns `undefined`, expecting the curated loader
to be blind to a versioned model. It actually returns `curated/deepseek.md` — the family
file — which is correct and intended. Replaced with an assertion on *content*: the
curated result carries `## Autonomy and persistence` and not `Negation Rewrite Patch`;
the measured result is the reverse. Plus a case asserting the two kinds resolve to
disjoint directories.

## B2 — packaging re-check

Rebuilt. `dist/model-adaptations/{curated,measured}/` both present. Bundled
`dist/index.mjs` contains the kind-appending resolution, and both resolved paths exist
under `dist/`. Verified by inspecting the built artifact, not by trusting the config.

## Final verification

- `npx tsc --noEmit -p tsconfig.json` — clean
- `bun scripts/check-import-boundaries.mjs` — OK (1708 files)
- Full `vitest run` — **439 files, 7811 passed, 15 skipped, exit 0**

## Resolved since: item 1 — the v2/kosong divergence

The user chose to align kosong rather than keep the split. Two commits:

- `b183b6efc3` — `fix(kosong): reject contradictory DeepSeek cache fields, matching the v2 engine`
  `extractUsage` (`packages/kosong/src/providers/openai-common.ts`) now applies the same
  rule as v2's `readOpenAICacheFields`: reject the DeepSeek split when
  `hit + miss > prompt_tokens` and fall back to `cached_tokens` /
  `prompt_tokens_details.cached_tokens`. Three matching tests added to
  `packages/kosong/test/kimi.test.ts`.
- `953f6dbdf1` — changeset A's "known divergence" bullet replaced with a note that both
  engines now agree.

**Agreement verified empirically**, not by reading code: ran the same four payloads
(contradictory, fallback-to-cached, real capture `1792+219===2011`, partial split)
through both `extractUsage` and `parseOpenAIUsage`. All four produce identical
`{inputOther, inputCacheRead, output, inputCacheCreation}`.

Downstream re-verified because this is shared contract code: `node-sdk` (27 files /
271 tests), `oauth` (21 files / 364 tests), full `kosong` (50 files / 1400 tests), and
`agent-core-v2` typecheck plus the usage tests — all green.

## Resolved since: item 2 — silent fallback now reports

Two commits: `b22f8a93fa` (implementation) and `cc93f9cd14` (changeset).

The user chose the most thorough option: thread a logger into the llm layer, overriding the
earlier "no logger in llm" default.

- `src/human/log/log.ts` (new) — a minimal `LlmLogger` port the kernel defines itself.
  `human` must not import v2 domains, so it cannot reach `#/_base/log/log`; this keeps that
  boundary while letting callers opt in. Verified `#/log/log` resolves inside `human` and
  passes `check-import-boundaries`.
- `parseOpenAIUsage(usage, log?)` warns on rejection, including hit/miss and prompt total.
  `OpenAICacheFields` gained `rejected` and `reportedMiss` (the latter keeps the original
  value for reporting after `miss` is cleared).
- Threaded **construction-time**, not per-parse: `createOpenAIRequester({log})` →
  `createOpenAIFormat(log)` → `OpenAITransport.log`. `ProtocolAdapterRegistry` supplies
  `ILogService`. This matters: `docs/en/llm.md:71` forbids passing hooks into format, and a
  constructor argument is not a hook.

**A wrong assumption I made and fixed.** I first wrote the registry constructor as
`@ILogService private readonly log?: ILogger`, assuming TS optionality makes the DI
dependency optional. It does not — `DependencyKind` has no `'optional'`, and DI treats it
as hard. Result: 49 failures in `catalog.test.ts`
(`protocolAdapterRegistry depends on logService which is NOT registered`).

I then tried seeding a logger inside the shared `createScopedTestHost`, which broke
`sessionLogService.test.ts`: that test registers its own `ILogService` via
`registerScopedService` and asserts `appLog instanceof AppLogService`, which an
unconditional seed overrides. Both orderings (seed first, seed last) failed differently.
Final fix: leave the shared scaffolding alone and seed `SILENT_TEST_LOGGER` in the one host
that needs it, exporting the constant from `src/_base/di/test.ts` for reuse.

**Also fixed:** an earlier edit replaced the "keeps a split that reports less than the
prompt" test instead of appending; restored it (8 cases in that file, not 7).

## Deliberate leftovers

- ~~**v2 and kosong now disagree on cache-field rejection.**~~ **Resolved** — see above;
  both sides now reject contradictory splits.
- **No logger in the llm layer.** Usage-field mismatches fall back silently. Observability
  is a separate task; wiring `ILogger` through `createOpenAIRequester` is a cross-layer
  change neither convergence was meant to make.
- **No astron `enable_thinking` in v2.** Unchanged, per scope — the user reaffirmed this
  constraint in the same turn they authorised item 2, so it was not touched.

## Deployment (this turn)

Built and installed to `~/.kimi-code/bin/kimi` (the binary actually on PATH;
`/usr/local/bin/kimi` is a stale 0.38.0 root-owned leftover and was left alone per the
user's choice).

- Backed up first: `~/.kimi-code/bin/kimi.bak-20261010-042105`.
- `bun run build` — 25 files, 19.27 MB. `bun run smoke` passed.
- `bun run build:native:bun:release` — `dist-native/bin/linux-x64/kimi`, 179.1 MB,
  signed and checksum-verified. `bun run test:native:smoke` passed.
- Installed; `kimi --version` → 2.1.1, `kimi --help` runs.

Post-install checks that the convergences survived packaging:
- `dist/chunks/model-adaptations/{curated,measured}/` both present, with all four files.
- `loadCuratedAdaptation('deepseek-v3')` returns the curated family file and does not
  leak `Negation Rewrite Patch` from `measured/`; `gpt-4o` (outside the family) is undefined.
- v2 `parseOpenAIUsage` and kosong `extractUsage` agree on the contradictory payload
  (`{inputOther: 100, inputCacheRead: 0}`), and v2 warns once.

One wrong check worth recording: I first called
`loadModelAdaptation({model:'deepseek-v3', kind:'curated'})` and read `undefined` as a
failure. It is correct — `kind` selects a directory and the exact stem `deepseek-v3` is
not in `curated/`; the family fallback happens in `loadCuratedAdaptation`, which passes
`candidates: ['deepseek']`. My probe used the wrong entry point, not a real defect.

## Final verification (after item 2)

- `npx tsc --noEmit -p tsconfig.json` — clean
- `bun scripts/check-import-boundaries.mjs` — OK (1709 files)
- Full `vitest run` — **439 files, 7813 passed, 15 skipped, exit 0**


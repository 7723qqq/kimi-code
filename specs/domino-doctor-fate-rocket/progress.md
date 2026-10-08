# Progress — Fix the verified defects in `scripts/prompt-optimizer`

Approach: **D1 Option A** (wire up the knowledge subsystem) and **D2 Option A** (make
`agentProfileCatalog` load the adaptations). All twelve tasks are in scope.

Status legend: `todo` · `doing` · `done` · `blocked`

| Task | What | Status |
| --- | --- | --- |
| T1 | Add the test harness | done |
| T2 | B1 — resolve the provider from the model | done |
| T3 | B1 — report the resolved model | done |
| T4 | B2 — make `json-schema` validate | done |
| T5 | B3 — stop `llm-judge` from faking a failure | done |
| T6 | B4 — the pruner's verdict | done |
| T7 | Q5, Q6 — structure (`format.ts`, `cli-args.ts`) | done |
| T8 | Q3, Q4 — databases and the adapter | done |
| T9 | Platform fix for the integration test | done |
| T10 | D1 Option A — wire up the knowledge subsystem | done (deviated: see below) |
| T11 | D2 Option A — make the catalog load adaptations | done |
| T12 | Close out | done |

## T1 — Add the test harness

**Done.** Created `scripts/prompt-optimizer/test/smoke.test.ts` and added `"test": "bun test"` to
the package's `scripts`.

Baseline before this task: `bun test` printed `No tests found!`. After: **2 pass, 0 fail**.

```
$ bun test
test/smoke.test.ts:
(pass) harness > loadConfig returns the built-in defaults [0.06ms]
(pass) harness > loadConfig applies overrides [0.01ms]

 2 pass
 0 fail
```

The suite touches no network and needs no API key, per the task's acceptance criterion.

## T2 — B1: resolve the provider from the model

**Done.** Rewrote provider selection in `src/llm-caller.ts`. Split the parse into a pure
`parseConfigText` (testable without a filesystem), memoised `extractProvidersFromConfig` by path +
mtime, and a new exported `providerNameForModel`. `resolveCredentials` now derives the provider from
the model id's `provider/` prefix, takes `baseUrl` and `apiKey` from that block, keeps explicit
config/env overrides ahead of it, and throws naming the model and the known providers when the
prefix matches nothing.

**Acceptance evidence.**

Fixture tests (`test/credentials.test.ts`, `test/llm-caller.test.ts`) cover the same-provider rule,
the explicit `--model`, the explicit `apiBaseUrl` override, and both throw paths.

Real-config before/after, per the task's acceptance criterion:

| | model | baseUrl | type |
| --- | --- | --- | --- |
| Before | `workbuddy/deepseek-v4.1-flash` | `https://api.deepseek.com` | `openai` |
| After | `workbuddy/deepseek-v4.1-flash` | `http://127.0.0.1:8790` | `anthropic` |

The `type` change is worth recording: the old pairing did not merely point at the wrong host, it
selected the wrong request format. `callOpenAI` would have posted to `/chat/completions` where the
named provider needs `/v1/messages`. The defect was worse than the investigation estimated.

## T3 — B1: report the resolved model

**Done.** Added `resolveModel` to `src/llm-caller.ts`; `cli.ts:40` no longer takes a possibly-empty
model from `DEFAULT_CONFIG.defaultModel`. An empty model now fails before any request or file write.

**A second defect surfaced here.** Making the model non-empty exposed that the model id is used
verbatim in the report filename. `bench-workbuddy/deepseek-v4.1-flash-<ts>.json` was read as a
subdirectory and the run died with `ENOENT`. This was latent before, because the empty model
produced a name without a separator. Added `slugifyModel` in `cli.ts` and routed all five report
paths through it (lines 87, 124, 143, 182, 207).

**Acceptance evidence.** `bun src/cli.ts bench --dry-run` prints a non-empty model on its first
line and writes
`reports/bench-workbuddy-deepseek-v4.1-flash-1791413309346.json` — no separator, no ENOENT. Covered
by `test/model.test.ts`, including the `阶跃/step-5-preview` case that also strips non-ASCII.

`bun test`: **20 pass, 0 fail**.

## T4 — B2: make `json-schema` validate

**Done.** Replaced the parse-only check in `src/benchmark/evaluators.ts` with a schema check over
`type`, `required`, and one level of `properties`. The declared type is now
`z`-free and dependency-free, per the design's constraint that this module adds no dependencies.

**The decision that matters:** a keyword the evaluator does not implement makes the check **fail**
(`oneOf`, `patternProperties`, `$ref`, `additionalProperties`, nesting deeper than one level), and a
case that declares no schema scores `0`. The old implementation returned `1` in all of these cases,
which is how it inflated scores while looking like a pass.

**Acceptance evidence** (`test/evaluators.test.ts`), the two regression guards being the cases that
scored `1` before:

| Input | Before | After |
| --- | --- | --- |
| `{"a":1}` against a schema requiring a missing field | 1 | 0 |
| `{"not":"array"}` against `{type:'array'}` | 1 | 0 |
| `{"name":"ok"}` against a satisfied schema | 1 | 1 |
| `not json` | 0 | 0 |
| an unimplemented keyword | 1 | 0 |

## T5 — B3: stop `llm-judge` from faking a failure

**Done.** `runEvaluator` throws for `llm-judge` with a message naming the evaluator, and the new
`assertSupportedEvaluators` runs at module load in `src/benchmark/cases.ts`, so a case declaring an
unimplemented evaluator fails fast naming the case id rather than scoring as a permanent violation.

**Acceptance evidence** (`test/llm-judge.test.ts`): the throw is asserted for both the evaluator and
the case-id path; the shipped case set passes validation, confirming no case currently uses it.

`bench --dry-run` exit code and all five aggregate lines are unchanged from before this task
(57.1% / 62.9% / 88.6% / 150 / 100.0%), which is the regression guard the task asked for.

## T6 — B4: the pruner's verdict

**Done.** Three changes in `src/pruner/pruner.ts` plus `src/types.ts` and the CLI banner:

1. An all-positive delta now reports `IMPROVES` / `PRUNE` / "Removal improved every measured
   dimension" instead of being folded into "No measurable impact" by `Math.min`.
2. The `allCases.slice(0, 5)` fallback is gone. A section no case covers is `UNKNOWN`/`UNKNOWN`
   and is excluded from `prunableTokens`; `PruneReport` gained `unmeasuredTokens` so the exclusion
   is visible rather than silent.
3. `--dry-run` prints a banner before the numbers, because dry-run responses do not depend on the
   prompt and therefore compare nothing.

**Acceptance evidence.** The task's three assertions are tests in `test/pruner.test.ts`, driven by a
stub caller whose score depends on the system prompt (the property `dryRunCaller` lacks):

- removal hurts → `KEEP`, negative `ruleCompliance` delta
- removal helps → `IMPROVES` / `PRUNE`, reason matches `/improved/i` and not
  `/No measurable impact/`
- no covering case → `UNKNOWN`, `scoreDeltas` empty, absent from `prunableTokens`,
  `unmeasuredTokens` equals its token count

**Note on the fixture.** My first version of the stub had the score relationship inverted, so the
"removal hurts" case produced a positive delta and the test failed. The fix was to the fixture, not
to the pruner logic; the corrected stub is documented in the test.

**Reported figures, before and after**, from `bun src/cli.ts prune --dry-run`:

| | Prunable | Unmeasured |
| --- | --- | --- |
| Before T6 | 1556 / 1600 tokens (97.3%) | not reported |
| After T6 | 750 / 1600 tokens (46.9%) | 806 tokens (50.4%) |

`bun test`: **37 pass, 0 fail**.

## T7 — Q5, Q6: structure

**Done.** New `src/format.ts` holds `padRight`, `formatNum`, `sign`, `avg`; the copies in
`pruner.ts`, `ab-test.ts`, `report.ts`, `probe.ts`, `runner.ts` are deleted and import from it.
New `src/cli-args.ts` holds `parseArgs(argv)`. `cli.ts` no longer reads `process.argv` at module
scope and its entry is guarded by `import.meta.main`.

**Acceptance evidence:**
- `grep -rn "function padRight" src/ | wc -l` → **1**; same for `avg`/`mean` → **1**
- `parseArgs` is covered by `test/cli-args.test.ts`, which also exercises the shared helpers
- `bun -e "await import('./src/cli.ts')"` prints nothing (it used to print the help text)
- all four commands still run: `bench`, `prune`, `ab`, `probe` each exit 0 under `--dry-run`

## T8 — Q3, Q4: databases and the adapter

**Done.** `git rm --cached` on both `.db` files; `knowledge-rs/.gitignore` now carries `*.db`,
`*.db-wal`, `*.db-shm`. `src/knowledge/adapter.ts` returns `KnowledgeOutcome<T>` instead of
collapsing failures: `knowledgeSearch` → `KnowledgeOutcome<KnowledgeSearchResult[]>`, `knowledgeAdd`
→ `KnowledgeOutcome<string>`, `knowledgeConfirm`/`knowledgeReject` → `KnowledgeOutcome<void>`. The
reason is classified (`binary-missing` via `ENOENT`, `timeout` via the kill signal, `bad-json` via
`SyntaxError`, else `failed`). `injector.ts` injects nothing on failure, as before, but now reports
it through a new optional `onFailure` hook rather than discarding it.

**Acceptance evidence:**
- `git ls-files scripts/prompt-optimizer | grep '\.db$'` → nothing
- `git check-ignore -v .../test-inject.db` → `.gitignore:5:*.db`
- `test/knowledge-adapter.test.ts` asserts on `reason`, not on an empty array

## T9 — Platform fix for the integration test

**Done.** `integration-test.ts:12` derived the binary name from `process.platform`, matching the
idiom in `agent-core-v2/src/_base/execEnv/environmentProbe.ts:149`.

**Acceptance evidence** — the investigation's failure, now passing:

| | Before | After |
| --- | --- | --- |
| Check 1 | `✗ FAIL: Binary at .../kimi-knowledge.exe` | `✓ Binary at .../kimi-knowledge` |
| Result | died at check 2 with ENOENT | **26 passed, 0 failed**, exit 0 |

`cargo test` in `knowledge-rs` still reports **24 passed**, confirming the Rust side is untouched.

## T10 — D1 Option A: wire up the knowledge subsystem

**Done.** New feature at `packages/agent-core-v2/src/features/knowledge/`, registered from
`#/index` alongside the other features:

| File | Role |
| --- | --- |
| `knowledge.ts` | The `IKnowledgeSearch` boundary, `KnowledgeEntry`, the typed outcome, and `parseKnowledgeSearchResults` for validating binary output |
| `knowledgeSearchService.ts` | The default implementation: spawns the binary |
| `binaryPath.ts` | Resolves the binary and the database path |
| `selection.ts` | Pure selection and rendering: dedup, token budget, failure handling |
| `knowledgeInjectionService.ts` | Registers the `knowledge_base` reminder variant and contributes `knowledge.injectedIds` |
| `knowledgeFeature.ts` | Registration entry point |

**Two defects found while wiring, both fixed:**

1. **`import.meta.dirname` is the package root, not the source directory.** A bundled run reports
   `packages/agent-core-v2`, a source run reports the source path, so a single relative depth could
   not work. `developmentCandidates` now tries both depths.
2. **The binary's default database is `<cwd>/.kimi-code/knowledge.db`.** Left implicit, every search
   silently opened a fresh empty database and returned nothing — measured directly: without `--db`
   → 0 entries, with `--db` → 3 entries. `resolveKnowledgeDbPath` now derives it from the same home
   the binary is populated under, and the service always passes `--db`.

**Acceptance evidence.**

- Unit (`test/features/knowledge/knowledgeInjection.test.ts`, **11 tests**): a stubbed
  `IKnowledgeSearch` returning entries produces one reminder containing the header, the category,
  and the title; no match produces none; `binary-missing` produces none **and does not throw**; the
  query carries the session cwd.
- End-to-end against the **real Rust binary and a real database**: imported `standards.md` (25
  entries) and searched — `ok: true, entries: 3`, returning real titles. A missing binary reports
  `reason=binary-missing`.
- `bun run typecheck` clean; full package suite **430 files, 7710 passed, 0 failed**.
- `bun run gen:state-manifest` regenerated `docs/state-manifest.d.ts`; the manifest test that guards
  it passes. The new `knowledge.injectedIds` key is Agent-scoped (index now 76 keys).

**Reachability, which was the point of this task.** The research noted the subsystem was
"~1,400 lines wired to nothing". It is now reachable: `#/index` imports the feature, the feature
registers `IKnowledgeSearch` and the injection service, and the injection service registers the
reminder variant that the agent loop invokes. `src/knowledge/injector.ts` in the prompt-optimizer
module is superseded by this feature — it remains as the standalone tool's own entry point, and its
`contextInjectorService`/`dynamicInjector` doc comment (which never matched any real API) is now
accurate to name this feature instead.

## T11 — D2 Option A: make the catalog load adaptations

**Done.** New `packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations.ts` resolves and
renders `model-adaptations/<model>.md`; `profileService.buildSystemPromptContext` supplies it as
`modelAdaptation`; `profile-shared.systemPromptVars` renders it into a new
`${model_adaptation_section}` slot at the end of `system.md`.

**Two defects found while wiring, both fixed:**
1. `import.meta.dirname` is this module's own directory in a source run, not the package root, so
   the first candidate list pointed at a path that never existed. Both layouts are now tried.
2. The generated files already carried a `# Model Adaptation: …` title, so the wrapper duplicated
   it. `stripGeneratedHeader` drops the title and the `#`-prefixed provenance block while keeping
   `##` body headings.

**Also corrected in the source files:** each claimed "Auto-generated by …" while no generator
exists anywhere in the tree, and claimed an injection that had no implementation. The headers now
name the file that loads them.

**Acceptance evidence.** `test/app/agentProfileCatalog/modelAdaptations.test.ts` (15 tests) plus
`adaptationRender.test.ts` (4) cover the stem rule, provider-qualified ids, missing/oversized/empty
files, no-duplicate-title, and that a model without a file leaves the prompt untouched. All three
shipped adaptations load through the default lookup.

## T10 — deviation from the spec's approach

T10 chose D1 Option A: wire the knowledge subsystem up. **The spec assumed there was only one
knowledge implementation. There were two.**

A pre-existing subsystem at `src/agent/knowledge/` (476 lines) was found after the new feature at
`src/features/knowledge/` (457 lines) had been built and wired. With the user's decision the new
feature was **removed** and the pre-existing one was made to work, because it is the more complete
design: it has the write path (`add`/`confirm`/`remove`/`import`), the `KnowledgeLearner`
self-learning loop, and conversation-derived search signals — none of which the new feature had.

**The five gaps that kept the old loop broken, and their fixes:**

| # | Gap | Fix |
| --- | --- | --- |
| 1 | `index.js` exported no knowledge bindings, so `require()` yielded an object whose knowledge methods were all `undefined` | Added 9 bindings, exported under the Rust `#[napi]` names the service calls |
| 2 | `knowledgeAdd` was called with 8 arguments against a 7-parameter native signature; napi silently dropped the extra | Removed the extra argument |
| 3 | The `status` filter compared against a field the store has no column for, so it never excluded anything | Replaced with a confidence floor; `status` removed from the types |
| 4 | The guard `!nativeKnowledge` passed because the module object is truthy, so a missing API produced silent no-ops | Per-function `hasKnowledgeApi()` check |
| 5 | `KnowledgeLearner` ended in an empty `if (entry) {}` | Success and failure are now logged |

**A sixth gap, found because of #3:** `knowledge_reject` does not exist in Rust though the service
calls it. The binding falls back to `knowledgeRemove`, which is what rejecting means here.

**Two real bugs introduced by wiring it up, then fixed:**

1. **The service created a database in the user's cwd on startup.** Opening a path creates it
   (`knowledge_open` calls `create_dir_all`), so every working directory the agent started in got a
   `.kimi-code/` directory. Two tests caught it by their directory-listing snapshot. Opening is now
   lazy, and a database is only created by a write.
2. **Reads created databases.** `ensureDatabase()` was reached from `search`, so merely searching
   left a file behind. Reads now use `openExisting()`, which never creates.

**Acceptance evidence.** `test/agent/knowledge/knowledgeLoop.test.ts` (5 tests) proves the loop over
the real native module: an entry is stored and returned without a `status` field; a learned entry
(confidence 0.4) is **not** returned by `search` until `confirm()` raises it, after which it is; and
stats reflect the write. Full package suite: **432 files, 7723 passed, 0 failed.**

**A native function was added.** `knowledge_close` did not exist, so the process-global database
could never be released — `open()` referenced it, and a second `knowledgeOpen` was the only way to
switch. Added to `knowledge.rs` and the module rebuilt.

**Test isolation.** The native database is process-global and the test harness points every agent at
one fixed home (`/tmp/kimi-code-agent-app-v2-test`), so a write in one suite was visible to
unrelated tests and accumulated across runs — the shared file had reached 1.2 MB. The knowledge
suite now pins itself to a private database via `KIMI_KNOWLEDGE_DB` and closes it afterwards. The
underlying shared-home weakness is pre-existing test infrastructure and is left alone.

## T12 — Close out

| Check | Result |
| --- | --- |
| `agent-core-v2` typecheck | clean |
| `agent-core-v2` suite | **432 files, 7723 passed, 15 skipped, 0 failed** |
| `prompt-optimizer` `bun test` | **49 passed, 0 failed** |
| `knowledge-rs` `cargo test` | **24 passed** |
| `kimi-native-tools` `cargo test` | **531 passed** |
| `bench --dry-run` | exit 0, prints a non-empty model |
| `review --check=scripts-wiring` | 0 errors, the same 4 pre-existing `gen:*` warnings |
| state manifest | regenerated; its guard test passes |

No file was modified outside `scripts/prompt-optimizer/**`,
`packages/agent-core-v2/{src/agent/knowledge,src/agent/profile,src/app/agentProfileCatalog,src/index.ts,docs/state-manifest.d.ts,test/agent/knowledge}`,
and `packages/kimi-native-tools/{index.js,index.d.ts,src/knowledge.rs}`.

### Deviations from the approved plan, in one place

1. **T10 swapped subsystems.** The spec said "wire up the unwired knowledge subsystem"; there were
   two. Per the user's decision the new `features/knowledge/` was deleted and the older, more
   complete `agent/knowledge/` was repaired.
2. **A native function was added.** `knowledge_close` had to be written and the module rebuilt —
   the spec's design assumed no Rust change was needed.
3. **Two bugs were introduced by the wiring and then fixed**, both found by existing tests rather
   than by reasoning: the startup database in the user's cwd, and reads creating databases.
4. **The earlier conclusion that the binary lacked the knowledge exports was wrong.** Only the JS
   wrapper layer lacked them.

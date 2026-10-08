# Design — Fix the verified defects in `scripts/prompt-optimizer`

## Constraints that shape everything

**`scripts/prompt-optimizer` is outside the type checker.** The root `tsconfig.json` includes only
`packages/*/{src,test}` and `apps/*/{src,test}`, so `strict` and `noUncheckedIndexedAccess` do not
apply here. Every fix below must therefore be verifiable by *running* it, because the compiler will
not catch a mistake.

**The module has no TypeScript tests.** `find -name '*.test.ts'` returns nothing under the module,
and it is not registered with `vitest.config.ts`. There is no existing harness to extend, so checks
are added as a small `bun test` suite (Bun's built-in runner, already the module's runtime per
`package.json`).

**Rust is tested.** `cargo test` in `knowledge-rs` passes 24 tests. Any Rust change keeps that green.

**Verification commands**, used by the acceptance criteria throughout:

```
cd scripts/prompt-optimizer && bun test
cd scripts/prompt-optimizer/knowledge-rs && cargo test
cd scripts/prompt-optimizer && bun src/cli.ts bench --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts prune --dry-run
```

## B1 — Provider selection follows the model

**Root cause.** `llm-caller.ts:87` picks the provider by a hardcoded name list
(`newapi` → `deepseek` → first entry) while `:104` takes the model from `default_model`. The two are
unrelated, so the model name and the base URL come from different provider blocks.

**Fix.** The model key already carries its provider as a prefix — `default_model =
"workbuddy/deepseek-v4.1-flash"`, and `[models."opencode/laguna-s-2.1-free"]`. Resolve the provider
by the part before the first `/`, and make the lookup the *only* source of the base URL:

```
resolveCredentials(config):
  parse config.toml once            -> providers, defaultModel, modelKeys
  model = config.model || defaultModel
  providerName =
      if model contains '/'         -> the prefix
      elif config.apiBaseUrl set    -> undefined (explicit override wins)
      else                          -> undefined
  provider = providers[providerName]
  baseUrl  = config.apiBaseUrl || provider.baseUrl || env fallbacks
  apiKey   = config.apiKey || env || provider.apiKey
```

**Failure mode (required).** If a model names a provider that is not in the file, throw:

```
No provider "workbuddy" in ~/.kimi-code/config.toml (model "workbuddy/deepseek-v4.1-flash").
Known providers: deepseek, google-gemini, opencode, ...
```

This is the difference between a confusing 404 and an actionable message. An explicit
`--model` that names no provider is operator error and must not silently fall back.

**Rejected alternative:** keep the name list but reorder it. It stays wrong the moment the operator
changes `default_model`, which is exactly the reported symptom.

**Caching.** `resolveCredentials` is called once per `realCaller` invocation. Measured cost is
0.13 ms/call, so this is not a performance fix; but the parse is memoised by config path + mtime so
a single run does it once. This is a small, contained change, not the parser rewrite that
`requirements.md` excludes.

## B2, B3 — The two evaluators that lie

**B2 (`json-schema`).** Validate with a minimal, dependency-free check against the schema in
`params`: `type` (`object`/`array`/`string`/`number`/`boolean`/`null`), `required` for objects, and
`properties` recursed one level. Return `1` only on a match. A schema the evaluator cannot
understand returns `0` and is reported, never silently `1`.

**B3 (`llm-judge`).** Two viable fixes; the spec picks the strict one because the honest alternative
costs a network call per case in a benchmark that already makes hundreds:

- `runEvaluator` throws for `llm-judge` instead of returning `0`, and `cases.ts` is validated at
  load so a case declaring it fails fast with the case id.

Since no case currently declares `llm-judge`, this changes no existing score. The type stays in
`EvaluatorType` so the door is left open, but the door now has a sign on it.

**Rejected alternative:** implement a real LLM judge. It would need its own caller wiring, its own
prompt, and a second model round-trip per case; that is a feature, not a defect fix.

## B4 — The pruner's verdict

**Root cause.** `pruner.ts:75` takes `Math.min(complianceDelta, toolDelta, passRateDelta)`. A
positive delta — removal *improved* the score — is smaller than the negative floor is large, but the
comparison at `:81` tests `maxNegativeDelta >= -0.02`, which a positive value satisfies. So a
section whose removal helped gets `impact: NONE`, `verdict: PRUNE`, and the reason "No measurable
impact when removed". Combined with `:59` falling back to `allCases.slice(0, 5)` for the four
sections no case covers, the report claimed 8/9 sections and 97.3% of the prompt were removable.

**Fix, three parts.**

1. **Report the real delta.** Keep a signed `worstDelta` for the verdict, but add the observed
   direction. A positive minimum on every dimension becomes its own verdict:

   | Condition | impact | verdict | reason |
   | --- | --- | --- | --- |
   | every delta `>= +0.02` | `IMPROVES` | `PRUNE` | `Removal improved every measured dimension` |
   | `worst >= -0.02` | `NONE` | `PRUNE` | `No measurable impact when removed` |
   | `worst >= -threshold` | `LOW` | `PRUNE` | as today |
   | `worst >= -2*threshold` | `MEDIUM` | `KEEP` | as today |
   | otherwise | `HIGH` | `KEEP` | as today |

2. **No unrelated cases.** When `getCasesBySection` returns nothing, do not substitute
   `allCases.slice(0, 5)`. Emit `impact: 'UNKNOWN'`, `verdict: 'UNKNOWN'`, reason
   `No benchmark case covers this section`, and exclude it from `prunableTokens`. An unmeasured
   section must not be counted as removable, and must not be counted as kept either.

3. **Say so when the run cannot measure.** `prune --dry-run` is not evidence about a prompt, because
   `dryRunCaller` ignores the system prompt entirely. When the caller is the dry-run one, the CLI
   prints a banner before the report: `dry-run: scores do not depend on the prompt; the verdicts
   below are not evidence.`

`PruneResult['impact']` and `['verdict']` gain the `UNKNOWN` and `IMPROVES` members; the PruneReport
table gains the same rows.

## Q3 — The committed databases

Remove `knowledge-rs/test-inject.db` and `knowledge-rs/integration-test2.db` from the index, add
`*.db` (plus `-wal`/`-shm`) to `knowledge-rs/.gitignore`. `git log` is the archive.

## Q4 — The adapter stops swallowing

`knowledge/adapter.ts` currently maps every failure to `[]`, `null`, `false`, or `true`. Replace the
four bare `catch {}` blocks with a typed result:

```ts
export type KnowledgeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'binary-missing' | 'timeout' | 'bad-json' | 'failed'; detail: string };
```

`knowledgeSearch` returns `KnowledgeOutcome<KnowledgeSearchResult[]>`. The existing call sites in
`injector.ts` treat a non-`ok` result as "inject nothing" — the behaviour is unchanged at the
injection boundary — but the reason is now available to the caller and to a log line.

This is the module's own convention question, not a repo-wide one; the review tool's `silent-catch`
check exists precisely because this pattern hides failures.

## Q5, Q6 — Structure

**Q5.** One `src/format.ts` exporting `padRight`, `formatNum`, `sign`, `avg`; the four copies
(`pruner.ts`, `ab-test.ts`, `report.ts`, `probe.ts`) and the two `avg`/`mean` copies (`runner.ts`,
`ab-test.ts`) import from it. `padRight` is byte-identical across all four today, so this is pure
deletion.

**Q6.** `cli.ts` currently reads `process.argv` at module scope, which is why importing it prints the
help text. Extract the parsing into `src/cli-args.ts`:

```ts
export interface CliArgs { command?: string; model?: string; reps: number; dryRun: boolean;
                           compare?: string; variant?: string; json: boolean; }
export function parseArgs(argv: readonly string[]): CliArgs;
```

`cli.ts` keeps only the `main()` wiring and calls `parseArgs(process.argv.slice(2))`. `parseArgs`
becomes unit-testable, and importing `cli.ts` no longer executes anything.

## Q1, Q2, B5 — Gated on decisions D1 and D2

These three are not designed in full here, because the design depends on decisions the maintainer
has not made. The two branches:

**D1 Option A (wire up).** The knowledge subsystem becomes reachable: `agent-core-v2` gains an
injection point that calls `injector.ts`, the Rust binary gains a build step and a documented install
path, and `integration-test.ts` becomes a real `bun test` file with a platform-aware binary name.
Scope: a new provider registration in `agent-core-v2`, a build script, and de-coupling
`integration-test.ts` from the `.exe` suffix.

**D1 Option B (remove).** Delete `src/knowledge/` (3 files) and `knowledge-rs/` (the crate, its
tests, `standards.md`, the committed `.db` files). The `embedding` module and its `BLOB` column go
with it. This resolves Q1, Q2, and Q3 in one motion and removes ~1,400 lines that no caller reaches.

**D2 Option A (load the adaptations).** `agentProfileCatalog` reads `model-adaptations/<model>.md`
for the active model and prefixes it, next to the existing `system.md?raw` import at
`profile-shared.ts:12`. This needs a catalogue rule for matching a model id to a file name.

**D2 Option B (move the output).** The three committed files are deleted; `probe` writes to the
module's `reports/` directory (already gitignored), and the header claim "Injected into system
prompt when ... is the active model" is dropped because it is false. This follows the repo's own
rule that generated artifacts do not live under `packages/**/src/**`.

The spec's tasks make the ungated work T1–T8 and place the gated work last, so the maintainer can
approve the whole plan and still decide D1/D2 at execution time.

## Platform handling (the fixable half of Q2)

Independent of D1, `integration-test.ts:12` hardcodes `kimi-knowledge.exe` and therefore fails on
Linux even when the binary is present and executable — demonstrated in the investigation. Whatever
happens to the file under D1, the binary name must be derived from `process.platform`, matching the
idiom already in the repo (`agent-core-v2/src/_base/execEnv/environmentProbe.ts:149`).

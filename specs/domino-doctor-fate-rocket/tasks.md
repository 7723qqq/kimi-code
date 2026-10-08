# Tasks

Approach from `design.md`. T1–T8 are ungated: they can run whatever the maintainer decides about
D1 and D2. T9–T11 are gated on those decisions and are listed last.

Each task's acceptance is checkable by running a command. `bun test` means
`cd scripts/prompt-optimizer && bun test`.

## T1 — Add the test harness

The module has no TypeScript tests and is not in `vitest.config.ts`. Create
`scripts/prompt-optimizer/test/` and run it with Bun's built-in runner, adding `"test": "bun test"`
to the package's `package.json` scripts.

**Acceptance:** `bun test` exits 0 and reports at least one test. The suite touches no network and
no real API key — every test either calls a pure function or passes a stub caller.

## T2 — B1: resolve the provider from the model

Rewrite provider selection in `src/llm-caller.ts` per `design.md`: derive the provider from the part
before the first `/` in the model id; take `baseUrl` and `apiKey` from that provider block; keep
explicit config/env overrides ahead of it; throw with the model name and the known-provider list
when the prefix names no provider. Memoise the parse by config path + mtime.

**Acceptance:**
- A test with a fixture `config.toml` whose `default_model` is `workbuddy/deepseek-v4.1-flash` and
  which has both `[providers.workbuddy]` and `[providers.deepseek]` returns `baseUrl` from
  `workbuddy`.
- A test with `default_model` naming an absent provider throws, and the error message contains both
  the model id and the name of a provider that *does* exist.
- Run against the real config and record the result before/after:
  `bun -e "…resolveCredentials({model:'',apiBaseUrl:'',apiKey:'',concurrency:3})"`. Before: model
  `workbuddy/…`, baseUrl `https://api.deepseek.com`. After: baseUrl resolves to the `workbuddy`
  entry, or the run throws naming `workbuddy` if that provider has no `base_url`.

## T3 — B1 continued: report the resolved model

`DEFAULT_CONFIG.defaultModel` is `''`, so `bench --dry-run` prints `model: ` and writes
`bench--1791412778327.json` (`src/config.ts:16`, `src/cli.ts:40`). Resolve the model from
`config.toml`'s `default_model` when neither `--model` nor config supplies one, and refuse to start
with an empty model.

**Acceptance:** `bun src/cli.ts bench --dry-run` prints a non-empty model on its first line, and the
report path under `reports/` contains that model instead of `bench--<timestamp>.json`. Confirm by
listing `reports/` after the run.

## T4 — B2: make `json-schema` validate

Implement the checks in `design.md` (type, `required`, `properties` one level) in
`src/benchmark/evaluators.ts`. A schema the evaluator cannot interpret returns `0`.

**Acceptance:** each of these is a test:
- `{"a":1}` against a schema requiring a missing field → `0` (today: `1`)
- `{"not":"array"}` against `{type:'array'}` → `0` (today: `1`)
- `{"a":1}` against a schema it satisfies → `1`
- `not json` → `0`
- A schema using a keyword the evaluator does not implement → `0`, and the returned reason names
  the unimplemented keyword.

## T5 — B3: stop `llm-judge` from faking a failure

Make `runEvaluator` throw for `llm-judge` with a message naming the evaluator, and validate
benchmark cases at load so a case declaring it fails fast with the case id.

**Acceptance:**
- `runEvaluator({type:'llm-judge'}, ctx)` throws; the message is asserted.
- A test case declaring `llm-judge` makes `BENCHMARK_CASES` validation throw naming that case id.
- `bun src/cli.ts bench --dry-run` still exits 0 and prints the same five aggregate lines as before
  the change, proving no existing case regressed.

## T6 — B4: the pruner's verdict

Three changes in `src/pruner/pruner.ts` and `src/types.ts` per `design.md`: add the `IMPROVES`
verdict for all-positive deltas, replace the `allCases.slice(0, 5)` fallback with `UNKNOWN`, and
print the dry-run banner from `src/cli.ts`.

**Acceptance:**
- With a stub caller whose score drops when a section is removed, that section reports `KEEP` with a
  negative delta — a regression guard for the existing behaviour.
- With a stub caller whose score *rises* when the section is removed, that section reports
  `IMPROVES`/`PRUNE` and the reason says the removal improved the score. Today it reports
  `NONE`/`PRUNE` with "No measurable impact".
- A section with no matching case reports `UNKNOWN`/`UNKNOWN` and contributes `0` to
  `prunableTokens`; assert on the returned report object, not on printed text.
- `bun src/cli.ts prune --dry-run` prints the dry-run banner, and the report no longer claims a
  `prunableTokens` total that includes unmeasured sections. The token figure before this change was
  1556/1600 (97.3%); record the new figure in the task's done note.

## T7 — Q5, Q6: structure

Add `src/format.ts` with `padRight`, `formatNum`, `sign`, `avg`; delete the duplicates from
`pruner.ts`, `ab-test.ts`, `report.ts`, `probe.ts`, `runner.ts`. Extract argv parsing into
`src/cli-args.ts` exporting `parseArgs(argv)` per `design.md`.

**Acceptance:**
- `grep -c "function padRight" src/**/*.ts` finds exactly one definition; same for `avg`/`mean`.
- `parseArgs(['bench','--model','x','--dry-run'])` returns the expected struct — a test, no process
  spawn.
- `bun -e "await import('./src/cli.ts')"` prints nothing and exits 0 (today it prints the help text).

## T8 — Q3, Q4: databases and the adapter

`git rm --cached` both `.db` files, add `*.db`, `*.db-wal`, `*.db-shm` to
`knowledge-rs/.gitignore`. Replace the four bare `catch {}` blocks in `src/knowledge/adapter.ts`
with the typed `KnowledgeOutcome` from `design.md`, updating its call sites in `injector.ts` to treat
non-`ok` as "inject nothing".

**Acceptance:**
- `git ls-files scripts/prompt-optimizer | grep '\.db$'` prints nothing; `git status` shows both
  files deleted and the `.gitignore` modified.
- `git check-ignore -v scripts/prompt-optimizer/knowledge-rs/test-inject.db` reports a matching rule.
- `knowledgeSearch` with a non-existent binary returns `{ok:false, reason:'binary-missing'}` and the
  test asserts on `reason`, not on an empty array.

## T9 — Platform fix for the integration test (ungated half of Q2)

`src/knowledge/integration-test.ts:12` hardcodes `kimi-knowledge.exe`, so it fails on Linux even
with the binary built and present — reproduced in the investigation. Derive the suffix from
`process.platform`, matching `agent-core-v2/src/_base/execEnv/environmentProbe.ts:149`.

**Acceptance:** with `cargo build --release` run in `knowledge-rs`, executing the file on this Linux
box gets past check 1 (`Binary exists` passes) and reports a non-zero `passed` count. Which later
checks pass is not asserted — the DB schema and `standards.md` counts are outside this task.

## T10 — D1: the knowledge subsystem (gated)

**Do not start until D1 is answered.**

- **Option A (wire up):** register an injection point in `agent-core-v2` that calls
  `knowledgeInjectionProvider`, add a build/install step for the Rust binary, and convert
  `integration-test.ts` into a `bun test` file. Acceptance: a test in `agent-core-v2` asserts the
  provider returns formatted text for a stubbed adapter, and the end-to-end test runs against a
  freshly built binary on Linux and on Windows.
- **Option B (remove):** delete `src/knowledge/` and `knowledge-rs/` including the crate, its
  `standards.md`, and the `.db` files. Acceptance: `grep -rn "knowledge-rs\|kimi-knowledge"` over
  the repo (excluding `specs/` and `reports/`) returns nothing; `bun src/cli.ts bench --dry-run`
  still exits 0.

## T11 — D2: `model-adaptations/` (gated)

**Do not start until D2 is answered.**

- **Option A (load them):** teach `agentProfileCatalog` to read `model-adaptations/<model>.md` for
  the active model and prefix it. Acceptance: a test asserting the prefix appears for a mocked
  model with a file and is absent for a model without one.
- **Option B (move the output):** delete the three committed files, point `probe` output at
  `reports/`, and drop the false "Injected into system prompt" header line. Acceptance:
  `git ls-files packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/` prints
  nothing; running `probe` writes under `reports/` (gitignored); the generated header no longer
  claims injection.

## T12 — Close out

Run the full verification set and record the output in the done note:

```
cd scripts/prompt-optimizer && bun test
cd scripts/prompt-optimizer/knowledge-rs && cargo test      # if T10 Option A or untouched
cd scripts/prompt-optimizer && bun src/cli.ts bench --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts prune --dry-run
./tools/review/zig-out/bin/review --check=scripts-wiring
```

**Acceptance:** `bun test` and `cargo test` exit 0; `cargo test` still reports 24 passed for the
untouched crate; `bench --dry-run` exits 0 and prints a non-empty model; the review check reports no
new findings beyond the four pre-existing `gen:*` warnings in `packages/agent-core-v2`. `git status`
shows no file modified outside `scripts/prompt-optimizer/`, `specs/`, and the `.gitignore` in T8.

## Ordering note

T1 before T2–T8, because those tasks add tests to the harness T1 creates. T2 and T3 are one logical
change to credential resolution and may be done together. T10 and T11 depend on decisions, not on
earlier tasks.

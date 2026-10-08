# Requirements — Fix the verified defects in `scripts/prompt-optimizer`

## Goal

Fix the defects that a prior investigation verified in `scripts/prompt-optimizer`, and only those.
Each defect below carries one of three verdicts from that investigation: **confirmed bug**,
**code-quality issue**, or **my earlier misjudgement**. The misjudgements are listed so this spec
does not re-fix things that are not broken.

The deliverable is source changes plus the checks that prove each fix. No defect is closed on
reasoning alone.

## Audience

The repository maintainer who owns this module. They already read the investigation, so this spec
does not re-argue whether each defect is real — it states the fix and how to verify it.

## In scope

### Confirmed bugs

| ID | Defect | Evidence already gathered |
| --- | --- | --- |
| B1 | Model name and provider credentials come from different providers | `resolveCredentials()` on the real `config.toml` returns model `workbuddy/deepseek-v4.1-flash` with `baseUrl` `https://api.deepseek.com` |
| B2 | `json-schema` evaluator discards its `params` and only checks parseability | Three probe calls returned `1` for a wrong-type value and for a schema requiring a missing field |
| B3 | `llm-judge` evaluator always scores `0`, so any case declaring it is a permanent violation | Probe returned `{"ruleCompliance":0,"violations":["judge-me"]}` |
| B4 | Pruner discards positive score deltas, so a section whose removal *helps* is reported as free to remove | `runPruner` produced 8/9 sections `PRUNE`, 97.3% prunable; a probe showed `complianceDelta=+0.286` folded into `impact: NONE` |
| B5 | `model-adaptations/*.md` files are unreferenced, and each claims an injection that has no implementation | Zero references repo-wide; no `adaptation` logic in `agent-core-v2` |

### Code-quality issues

| ID | Issue | Evidence already gathered |
| --- | --- | --- |
| Q1 | Rust `embedding` module is dead code behind `#[allow(dead_code)]`; the `embedding BLOB` column is never read or written | Removing the attribute yields 3 `never used` warnings |
| Q2 | `src/knowledge/` is wired to nothing; its integration test hardcodes a `.exe` path and fails on Linux | Running it with a freshly built Linux binary still reports `Binary exists ✗ FAIL` |
| Q3 | Two SQLite files are committed | `git ls-files` lists both; `git check-ignore` reports NOT IGNORED |
| Q4 | `src/knowledge/adapter.ts` swallows every failure into an empty result | A missing binary and "no matches" both return `[]` |
| Q5 | `padRight` is duplicated in four files; `avg`/`mean` in two | Byte-identical implementations confirmed |
| Q6 | `cli.ts` keeps argv in module-level state and cannot be imported without running `main()` | Importing the module prints the help text |

### Explicitly not in scope

Misjudgements and downgraded items from the investigation. Do not "fix" these:

- **A/B significance is not broken.** `repetitions: 1` already yields n=35 per variant, above the
  `n < 3` guard; raising it to 3 changed nothing (1/4 significant either way). The all-tie output
  comes from `dryRunCaller` returning identical content regardless of the system prompt, which is
  what a dry run is for. The `iterations = 1000` permutation test and its comment mismatch remain
  as documentation drift only.
- **`runSuite`'s `splice(indexOf(...), 1)` is not a bug.** Adversarial stress runs (all promises
  settling in one microtask; n=12/30/50/100) lost nothing. It is fragile, not broken.
- **`bench:prompt*` being unwired is by design.** `tools/review/scripts-wiring-baseline.txt`
  deliberately exempts `bench:*` as a hand-run measurement tool.
- **`reports/` is correctly gitignored** (`git ls-files` count 0) — no action.
- **`Partial<PrunerConfig>` compiles and runs correctly** — no runtime defect to fix.
- **`G:/repo` strings in Rust unit tests** are test data, not platform coupling.

## Requirements

### R1 — Credentials resolve consistently

The model and the base URL handed to the API must come from the same provider entry in
`~/.kimi-code/config.toml`. When the operator names a model that no provider claims, the run must
fail with a message naming the model, rather than silently pairing it with an unrelated provider.

### R2 — The default model is never empty

`DEFAULT_CONFIG.defaultModel` must not be a hardcoded empty string that flows into report filenames
and request bodies. The resolved model is reported before the run starts.

### R3 — `json-schema` validates, or does not claim to

The evaluator either validates against the schema in `params`, or the type is removed from
`EvaluatorType`. A partially-implemented evaluator that silently passes is not acceptable, because
it inflates scores.

### R4 — `llm-judge` cannot silently fake a failure

The evaluator either works, or a case that declares it is rejected at load time. Silently scoring
`0` turns a supported-looking feature into a permanent violation.

### R5 — The pruner's verdict distinguishes "harmless" from "helpful"

A section whose removal does not lower any score is reported as removable. A section whose removal
*raises* a score must not be labelled "No measurable impact" — the report names that as a signal
worth acting on. A section that cannot be evaluated for lack of relevant cases must be labelled as
such, never scored against unrelated cases.

### R6 — `Q1`–`Q6` are resolved by decision, not by silence

Each of the six code-quality issues ends in one of two states: fixed, or removed. Leaving a dead
module behind an `#[allow(dead_code)]`, or an unreferenced test that fails on this platform, is what
the issue is.

## Open decisions

Two decisions materially change the design and are not the implementer's to guess. Both concern
"wire it up" versus "remove it":

**D1 — the knowledge subsystem (`Q1`, `Q2`, and the Rust `knowledge-rs` crate).** This subsystem is
~1,400 lines of tested Rust plus a TypeScript adapter and injector, wired to nothing. Option A
builds the injection point in `agent-core-v2` and makes the module live. Option B deletes the
unwired TypeScript and the Rust crate, keeping only what is reachable.

**D2 — `model-adaptations/` (`B5`).** Option A makes `agentProfileCatalog` load the files for the
active model. Option B moves generation output out of `packages/**/src/**` and deletes the
committed files, following the rule that generated artifacts do not live in source trees.

The spec below is written so that B1–B4, `Q3`–`Q6`, and the parts of `Q2` that are platform bugs can
proceed regardless of how D1 and D2 are answered. `Q1` and the rest of `Q2` are gated on D1; `B5` is
gated on D2.

## Non-goals

- Adding tests to `scripts/**` as a general policy. Only the module's own defects motivate a check,
  and each check is named in `tasks.md`.
- Bringing `scripts/prompt-optimizer` into the root `tsconfig.json` include list. That is a
  repo-wide decision about whether `scripts/**` is type-checked, not a fix for this module.
- Rewriting the hand-rolled TOML parser in `llm-caller.ts`. It is fragile, but R1 is satisfiable by
  fixing provider selection; a parser swap is a separate change.
- Changing `tools/review` or its baseline.
- Any change to the live system prompt `system.md` or to benchmark case content.

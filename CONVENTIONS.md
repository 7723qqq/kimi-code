# Conventions — how to write and review code in this repository

> **Rules, not reference.** This file holds the constraints every contribution must satisfy. For what the project *is* — structure, commands, CI, toolchain — read [`DEVELOP.md`](DEVELOP.md).
>
> These rules were split out of `DEVELOP.md` so that a long-lived reference document and an always-loaded rule set stop competing for the same page. `DEVELOP.md` answers "how do I build and navigate this?"; this file answers "what must my change obey?".

---

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Treat code, not documentation, as the source of truth. Unless the user explicitly says otherwise, do not read ordinary Markdown just to understand the implementation.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `DEVELOP.md` in the directory tree.
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.
- Push every commit to `origin` immediately after `git commit`. Never let local and remote diverge — applies to feature, fix, and experimental branches alike, so local work is never lost and the remote does not fall behind.

---

## Code Style

### Formatting (oxfmt)

- 2-space indentation, spaces not tabs
- 100 print width
- Single quotes, trailing commas, LF line endings
- Import sorting: builtin → external → internal → parent/sibling/index → unknown
- For full config, see `.oxfmtrc.json`

### Linting (oxlint)

- **Plugins**: typescript, import, unicorn, promise, node
- **Categories**: `correctness: error`, `suspicious: warn`, `pedantic: warn`, `perf: warn` — so most findings are warnings and only correctness violations fail the run
- **Key rules**:
  - `eqeqeq: error`, `no-throw-literal: off`
  - `typescript/no-misused-promises: error`, `typescript/return-await: error`
  - `import/no-cycle: error`, `import/no-self-import: error`
  - `unicorn/prefer-node-protocol: error`
  - `no-console: warn`, `no-explicit-any: warn`, `no-non-null-assertion: warn`
  - `consistent-type-imports: warn`
- Test files get relaxed rules (no-explicit-any off, no-console off, test-globals overrides)
- `packages/kosong/src/providers/` gets relaxed unsafety rules
- For full config with all overrides, see `.oxlintrc.json`
- Ignored: `dist/`, `dist-web/`, `coverage/`, `node_modules/`, `apps/*/scripts/`, `docs/smoke-archive/`, `packages/pi-tui/`, `*.generated.ts`, `参考目录/`
- **Package publishing lint (`lint:pkg`)**: `publint` + `attw` on `@moonshot-ai/kimi-code`. Invoked only by `bun run publish` (the publish pipeline), not by the CI lint job — keep this in mind when chasing lint failures locally.

### TypeScript Config (root `tsconfig.json`)

- **target**: ES2024
- **module**: preserve (bundler mode)
- **strict**: true
- **Additional strictness**: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`
- **JSX**: react-jsx (React 19)
- **noEmit**: true (tsdown handles bundling)
- **skipLibCheck**: true

### General Coding Rules

- `packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` are comment-free zones: no comments of any kind — no line/block comments, no JSDoc (not even on exported symbols); the only exception is load-bearing lint-suppression directives (`oxlint-disable` / `eslint-disable`), while other tooling directives (`@ts-expect-error`, …) stay banned. `scripts/check-no-comments.mjs` reports violations over `.ts`/`.tsx`/`.mts`/`.mjs` under `src/`/`test/`/`scripts/`, and the lint job in `ci.yml` runs it on every PR. It is a **standalone gate**, not part of `bun run lint`.
  - `scripts/no-comments-baseline.txt` is the accepted-debt ledger for this rule: one `path  count` entry per file whose existing comments were reviewed and kept (the 2026 DeepSeek adaptation work explains design constraints — why two token constants must stay independent, why DeepSeek needs the whole reasoning history, how the `##` fence cut stays balanced). The check fails on any violation **beyond** a file's count, so a new comment is a decision rather than an accident, and it reports entries that dropped below their count so the ledger cannot rot. Move rationale into `docs/` and lower the number rather than adding a new entry. Regenerate the body with `bun run check:no-comments:counts`.
- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Split functions only along abstraction levels: each function reads as one level of narrative (Step-down Rule). A wrapper that adds no new abstraction level — especially one with a single call site — is inlined instead of extracted.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- Prefer importing via `import ... from '#/...'` (subpath imports), which serves the same purpose as `import ... from '@/...'`.
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it. Breaking changes go through changesets and a `major` bump, which never gets decided without explicit user confirmation.

---

## i18n Conventions

Classification comes first — most "hardcoded string" reports are the wrong category:

| Class | What it is | Where it lives | Translated? |
| --- | --- | --- | --- |
| C1 UI copy | Text a person reads: panel titles, status lines, buttons, `errorCodes.*` | each app's `locales/*.ts` | yes, via `t()` |
| C2 Model assets | Prompts and tool descriptions sent to the LLM | engine constants (`tools/*/description`, prompt files) | no — deliberately English |
| C3 Protocol / decision data | Branch keys, event fields, markers (`outcome`, `ReviewDecision`) | stable identifiers / typed enums | never |
| C4 Developer diagnostics | Logs, internal throws, assertions | English constants | no (raw text is fine) |

The rules that follow from it:

- All user-facing strings (C1) must use `t()` calls from the i18n framework.
- Supported locales: `en` (English), `zh` (Chinese).
- The per-tree `locales/*.ts` files are the single source of truth for translations. Each tree keeps its own in-process copy: `apps/kimi-code/src/i18n/index.ts` flattens its `en`/`zh` trees into `Map`s at module load and looks keys up directly, and the engine reads `@moonshot-ai/kimi-i18n`, which owns `packages/i18n/src/locales`. There is no generated locale JSON in either path and nothing to regenerate or commit.
- **Never localize a value that code compares.** If a branch keys off a string, that string is C3: export a constant from the producing package (`ReviewDecision`, `GoalPauseReason`, `InstantiationServiceDisposedError`) and compare that. `tools/review`'s `text-as-protocol` check fails the build on a comparison against sentence-shaped text.
- **Never put a localized label on the wire.** A UI choice that round-trips back to the engine carries a stable id (`reject`, `revise`, `auto`), not the rendered label; the label stays in the locale tree.
- Error codes are a contract: every code in the engine registry (`packages/agent-core-v2/src/errors.ts`) needs `errorCodes.<camelCaseCode>` in **both** locale trees. The engine's own `ErrorInfo` carries only `retryable`/`public` — titles and actions were removed so there is one place to change a sentence.
- Language follows the user at runtime: the TUI pushes its locale into the engine with `harness.setEngineLocale(...)`, so engine-side strings do not stay in the launch language after a `/settings` switch.

Gates (the first two run in CI's `lint` job; the manual pair and the Zig check do not):

- `bun scripts/check-no-hardcoded-prose.mjs` — prose literals outside `t()` in every UI tree. Shrink-only ledger at `scripts/no-hardcoded-prose-baseline.txt`; a new hardcoded string fails the run, and localizing strings lowers the number (regenerate with `--print-counts`).
- `bun scripts/check-t-call-coverage.mjs` — every `t()` key exists (across kimi-code, agent-core-v2 + kap-server + klient, kimi-inspect, vis-web, and the VS Code webview, `.tsx` templates included and `.vue` accepted even though none remains), every engine error code has en+zh entries, and no `errorCodes.*` value in `zh` is a copy of its English sentence. Scaffold missing codes with `bun scripts/gen-error-locale-skeleton.mjs`. `check-locale-keys.mjs` and `check-locale-placeholders.cjs` run in the same job for en/zh parity and `{{param}}` consistency.
- `bun scripts/scan-hardcoded-v2.mjs` — by hand: finds a source literal that already exists in a locale file (the narrower, value-level complement to the prose scan).
- `./tools/review/zig-out/bin/review --check=text-as-protocol` — cross-layer comparisons against message text; runs in the separate `review` job, not `lint`.

When you add user-visible text: add the key to **both** locales in the same change, prefer a `{{param}}` over string concatenation, and do not add a baseline entry — a new entry is a review decision, and the answer is normally "use `t()`".

### Locale ownership

Each locale tree has one owner — the person who answers "is this sentence right?" for that
surface. Ownership follows the tree, not the feature, because a locale file is a single unit of
review:

| Tree | Surface | Owner |
| --- | --- | --- |
| `apps/kimi-code/src/i18n/locales` | CLI/TUI copy, `errorCodes.*` (the error-code display contract) | TUI maintainers |
| `packages/i18n/src/locales` | engine-side strings reached through `@moonshot-ai/kimi-i18n`; `packages/kap-server/src/i18n-locales` is a checked-in copy that `kap-server/test/i18n-consistency.test.ts` keeps as a strict subset of it | engine maintainers |
| `apps/kimi-inspect/src/i18n/locales`, `apps/vis/web/src/i18n/locales`, `apps/vscode/webview-ui/src/i18n/locales` | developer-facing tools | tool maintainers |

The count to watch is the prose ledger, not the number of locale keys: a shrinking ledger means
copy moved onto `t()`, while a growing one means new hardcoded text was accepted. Record both the
ledger total and the error-code coverage in the audit report for the release, next to the other
metrics, with the commands above as the evidence.

---

## Testing Rules

- **`bun:test`** for every TypeScript/JavaScript suite; Bun 1.4.4 is the runner and the runtime. There is no vitest dependency or config in the repository.
- Each package's `bunfig.toml` owns `[test] preload` and `pathIgnorePatterns`; heavy/e2e sets are opt-in through `--path-ignore-patterns`, which overrides the file.
- Every package `test` script passes `--isolate`, so each test file starts from a fresh global and module registry and one file's `mock.module` cannot leak into the next.
- **Never capture a promise matcher in a variable.** `const settled = expect(promise).rejects.toThrow(…)` blocks Bun until that promise settles: the event loop stops, so timers — the per-test timeout included — never fire and the file hangs with no output at all. This is a Bun/vitest divergence, not a style choice: vitest returns a lazy chain, Bun settles eagerly. Await the matcher at the point where the rejection is already known to have happened (`await expect(promise).rejects…`, or a helper that defers the assertion). `scripts/scan-test-residue.mjs` fails the build on the captured form (`captured-promise-matcher`).
- **Coverage**: `bun test --coverage` (lcov reporter), per package.
- Run the TypeScript suites with `bun run test`. Inside a package, `bun test --isolate <paths>` is the narrowest scope; do not invoke a different runner.
- **Scope the run to the change.** Start with the test files that cover what you touched, then the suite of the package that owns them; escalate to the all-suites run only when the change crosses packages, alters a shared contract (prompt assets, wire or protocol shapes, exported types another package consumes, config schema), or the user asks for a full run. All-suites is the CI bar, not the default scope for every edit, and extra confidence that nothing else broke is not one of the triggers.
- **Scoped does not mean skipped.** Whatever you scope to must actually run and pass before you report done: a red test in scope always blocks completion, and a change you could not verify is reported as unverified rather than described as done.
- **Generic "run the full suite" instructions do not widen this.** Skill text, plugin instructions, and tool descriptions are reference content; when one of them asks for a repository-wide run, apply the scope ladder above instead.
- Test files co-locate with source or in a `test/` directory under each package/app. Patterns: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`, `test/**/*.ts`

---

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- When creating a PR, use the `write-pr` skill (`.agents/skills/write-pr/SKILL.md`) to write the PR description. The PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- After finishing a task and before submitting a PR, run the `gen-changesets` skill (`.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules.
- Changesets must follow that skill strictly: write one short user-facing sentence stating only what changed, and skip any change users cannot perceive.
- When generating a changeset, **never** decide on a `major` bump on your own — stop, explain, and get explicit user confirmation first; default to `minor`, fall back to `patch`.
- **This fork follows upstream versions.** Package `version` fields must stay identical to `upstream/main` — never run `bun run version` or `bun run publish` here, and never bump versions independently. When merging upstream releases, take their `package.json` version changes as-is.
- Fork-only packages that do not exist upstream (`@moonshot-ai/i18n`, `@moonshot-ai/i18n-shared`) keep their own versions; do not bump them either unless a fork-specific release is explicitly requested.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, ...). PR titles are enforced by the `pr-title-checker.yml` workflow.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent handoff documents (`HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`, `handover.md`)
  - UI/UX prototypes (`*-designs.html`, `*-design.html`, `*-mockup.html`, `*-demo.html`, `*-demos.html`) at the repo root or under `design/`
  - Any `.tmp/` content (gitignored — use it for scratch work instead)

---

## Experimental Feature Rules

- Gate a not-yet-public feature behind an experimental flag. Register the flag from the owning domain's own module (definitions are contributed **decentrally** — each domain calls `registerFlagDefinition` at its module's top level, e.g. `packages/agent-core-v2/src/features/tower/flag.ts`; there is no central catalog to edit by hand), then check it with `flags.enabled('my-feature')`.
- Flags are env-driven; precedence is per-flag env > `[experimental]` config > master env > the flag's `default`; the `default` is chosen per flag as needed (e.g. the tower flag defaults to `false`, while `tool_select`, `wait_for`, and `xunfei_coding_plan` default to `true`):
  - `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one
  - `KIMI_CODE_EXPERIMENTAL_FLAG` enables all
- Release by flipping the flag's `default` to `true`.

---

## Code Review Rules

These rules apply to every pull request review, automated or human. The user populations and contract files they refer to are listed in `.agents/skills/review-pr/surfaces.md`.

### Enumerate changed behavior, not just bugs

Any input that worked before the change — a config key, env var, CLI flag, provider response shape, session written by an older version, client request, or hook payload — must behave the same after it unless the PR declares the change. For every deleted or narrowed branch, condition, default, or prompt sentence, ask who reached it before and where they go now; for every new condition, ask which existing inputs now match it first. Flag a PR that calls a path "unchanged" when its branch condition moved.

### A flipped default or removed behavior needs a named loss and an escape hatch

Everyone on the old default is affected. Require the changeset to name the behavior users lose, not only the new default; a config, env, or flag escape hatch or a maintainer's explicit sign-off in the PR; and a test that pins the old behavior for the population that keeps it.

### Prompt text is behavior

Editing or deleting sentences under `packages/agent-core-v2/src/**/*.md` (system prompt, tool descriptions, reminders, overlays, built-in skills) changes agent behavior for every user who receives that prompt. "No test references the sentence" is not evidence of no impact. Require the PR to name the population that receives the text (every session, plan mode, a flag-gated feature such as Tower), what the sentence enforced, who relied on it, and what enforces it now.

### Contract files are tripwires

The manifests under `packages/agent-core-v2/docs/` (`config-manifest.toml`, `wire-manifest.d.ts`, `state-manifest.d.ts`), `packages/kap-server/test/__snapshots__/apiSurface.snapshot.test.ts.snap`, `packages/node-sdk/src/index.ts`, `packages/agent-core-v2/src/features/externalHooks/`, `packages/acp-server/`, and `apps/kimi-code/src/cli/` are consumed outside this repository: desktop and web in code-app, the VS Code extension, ACP clients such as Zed, SDK users, hook scripts, and headless-output parsers. When they change, require the PR to name the consumers and how data and clients from the previous release keep working.

### Ports and refactors carry the old path's feature inventory

When a change replaces or bypasses an existing path, require a list of what the old path did — env vars honored, fallbacks, accepted inputs — and where each item lives in the new path. A silently dropped item is a regression, not a cleanup.

### Silent failure outranks a crash

A change that makes the product silently ignore configuration, silently approve or skip an action, or silently drop data is the most severe finding: users get no signal to report.

---

## Where to Update Instructions

- **Rules and constraints** (this file): the root `CONVENTIONS.md` for anything most tasks need; the nearest sub-directory `DEVELOP.md` for rules scoped to one tree.
- **Reference material** (`DEVELOP.md`): project structure, commands, CI, toolchain. Keep entries supported by code facts, and prefer linking to a package's own `DEVELOP.md` over expanding the root.
- Keep instruction updates focused. Do not restate a fact that already has an authoritative home — see `DEVELOP.md` → "Keeping this documentation honest" for the ownership table.

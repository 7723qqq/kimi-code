# Requirements — DeepSeek adaptation: collapse #1 and #4 into one structural change

## Goal

Two remaining DeepSeek adaptation findings — #1 (usage consistency) and #4 (adaptation
file kinds) — are currently symptoms of two structural gaps. Fix them with one small,
reviewable change each, so that neither fix is a patch:

- **#1** stops being "add a guard to one function" and becomes "usage semantics have a
  single owner inside v2".
- **#4** stops being "rename files to dodge a coincidence" and becomes "file kind is
  expressed by structure".

The three already-merged commits stay as-is.

## Audience

Maintainers reviewing two small, independently-mergeable commits in
`packages/agent-core-v2`. Reviewers need to see ownership boundaries, not diff noise.

## Scope

### In scope

1. **Convergence A (resolves #1)** — one module owns OpenAI-compatible usage semantics,
   including the DeepSeek cache-field variant and its arithmetic consistency rule.
2. **Convergence B (resolves #4)** — adaptation file kind (curated vs measured) is
   expressed by directory, and the loader resolves directories by kind.

### Out of scope (explicit)

- **No kosong changes.** `@moonshot-ai/kosong` is the shared provider wire contract
  (DEVELOP.md:182) and stays untouched.
- **No cross-package convergence.** v2 cannot import kosong — enforced by
  `check-import-boundaries.mjs:15,137` (`KOSONG_PATH_RE`), verified by running the
  checker. Convergence A therefore converges *inside* v2.
- **No logger in the llm layer.** `docs/en/llm.md:71` forbids passing hooks/traits into
  format, and `src/human/**` has zero `ILogger`/`ILogService` imports (counted).
  Convergence A does not thread `ILogger` through `createOpenAIRequester`. Observability
  of usage-field mismatches is a separate task.
- **No astron wire encoding in v2.** v2's `ProtocolSchema`
  (`src/llm-adapter/protocol/protocol.ts:10-16`) has no `astron`, and astron's
  `enable_thinking` lives in kosong (`packages/kosong/src/providers/openai-legacy.ts:687-702`).
  No `enable_thinking` is added to v2.
- **No changes to the three merged commits** (#3 shared curated gate, #2 dropped dead
  fields, #5 family-table boundary comment).

## Requirements

### R1 — Usage semantics have one owner in v2

`parseOpenAIUsage` currently mixes two jobs inside `format.ts:126-142`: recognising
DeepSeek's cache fields, and computing a `TokenUsage`. The two must be separable, with
recognition living outside `format.ts`.

Acceptance:
- A single module holds: DeepSeek field recognition, `TokenUsage` normalisation, and the
  arithmetic consistency rule.
- `format.ts` holds no usage semantics.
- External import path and signature of `parseOpenAIUsage` are unchanged.

### R2 — Usage fields that contradict each other are not trusted

When `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` sum to more than
`prompt_tokens`, the values cannot both be right.

Acceptance:
- `hit + miss > prompt_tokens` → fall back: `cached = cached_tokens ??
  prompt_tokens_details?.cached_tokens ?? 0`, `miss = undefined`.
- `hit + miss === prompt_tokens` → no fallback.
- `hit + miss < prompt_tokens` → no fallback.
- Verified by tests, not by inspection.

### R3 — File kind is structural, not coincidental

Today curated and measured files share one candidate chain, separated only because a
family prefix happens not to equal a versioned filename.

Acceptance:
- Kind is expressed by directory: `curated/` and `measured/`.
- The curated loader cannot see files under `measured/`, asserted by test.
- `modelFamily.ts` keeps answering family/pricing/prompt-shape only; it does not answer
  which file kind to read.

### R4 — Small, independent, reviewable

Acceptance:
- Convergence A and Convergence B are separate commits.
- A does not start until B's predecessor is green; B does not start until A is green.
- Each ships its own changeset entry.

### R5 — Packaging must actually work

Convergence B moves files. This is the one change that can pass every local test and
still fail in production, because tests pass `dir` and bypass directory search.

Acceptance:
- A real build runs before files are moved, and again after.
- `dist/` contains both `curated/` and `measured/` afterwards.
- If tsdown's `copy` does not recurse, fall back to a flat directory with kind-based
  filename filtering in `loadFrom`, and report it.

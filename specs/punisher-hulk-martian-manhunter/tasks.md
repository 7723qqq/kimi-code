# Tasks — DeepSeek adaptation convergences

Order matters: each task is a separate commit, and a task does not start until the
previous one is green. Commands assume `/home/administrator/kimi/kimi-code`.

Typecheck for every task:
`cd packages/agent-core-v2 && npx tsc --noEmit -p tsconfig.json` → exit 0.

---

## Task A1 — Add `usage.ts` as the single owner of OpenAI usage semantics

**Files**
- New `packages/agent-core-v2/src/human/llm/requester/bases/openai/usage.ts`
- `packages/agent-core-v2/src/human/llm/requester/bases/openai/format.ts:126-142`

**Do**
- `usage.ts` exports `readOpenAICacheFields(usage)` and `parseOpenAIUsage(usage)`.
- `readOpenAICacheFields` recognises `prompt_cache_hit_tokens` /
  `prompt_cache_miss_tokens`, falls back to `cached_tokens` /
  `prompt_tokens_details.cached_tokens`, and applies the rule:
  - `hit` present and `hit + miss > prompt_tokens` →
    `{ cached: cached_tokens ?? prompt_tokens_details?.cached_tokens ?? 0, miss: undefined }`
  - else → `{ cached: hit ?? cached_tokens ?? details ?? 0, miss }`
- `parseOpenAIUsage` builds `TokenUsage` from that, preserving today's shape
  (`inputOther = miss ?? Math.max(promptTokens - cached, 0)`, `inputCacheCreation: 0`,
  `raw: usage`).
- `format.ts` deletes its implementation and re-exports from `./usage`.

**Acceptance**
- `npx tsc --noEmit -p tsconfig.json` exits 0.
- `npx vitest run src/human/test/llm/deepseek-live-usage.test.ts` passes (3 existing cases
  unchanged; real capture `1792 + 219 === 2011` still yields `inputCacheRead: 1792`).
- `npx vitest run src/human/test/llm/usage.test.ts` passes (7 cases).
- `format.ts` contains no `prompt_cache_hit_tokens` reference.
- `requester.ts:37,168` unchanged and still resolves.

**Commit** — `refactor(agent-core-v2): give OpenAI usage semantics a single owning module`

---

## Task A2 — Tests for the consistency rule

**File** `packages/agent-core-v2/src/human/test/llm/deepseek-live-usage.test.ts`

**Do** — three cases:
1. `{ prompt_tokens: 100, prompt_cache_hit_tokens: 5000, prompt_cache_miss_tokens: 0 }`
   → `inputCacheRead: 0`, `inputOther: 100`.
2. `{ prompt_tokens: 2011, prompt_cache_hit_tokens: 1792, prompt_cache_miss_tokens: 219 }`
   → no fallback (`inputCacheRead: 1792`, `inputOther: 219`).
3. `{ prompt_tokens: 500, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 }`
   → no fallback (`inputCacheRead: 10`, `inputOther: 20`).

**Acceptance**
- `npx vitest run src/human/test/llm/deepseek-live-usage.test.ts` passes, 6 cases total.
- Case 1 asserts numbers, not merely "different from before".

**Commit** — `test(agent-core-v2): cover the DeepSeek cache-field consistency rule`

---

## Task A3 — Changeset for Convergence A

**File** `.changeset/deepseek-usage-consistency.md`

**Do** — follow `.changeset/deepseek-family-specialization.md` (patch bumps on
`@moonshot-ai/agent-core-v2`, `@moonshot-ai/kimi-code`, `@moonshot-ai/kimi-code-sdk`).
State: semantics moved to one module; fields whose sum exceeds `prompt_tokens` are
rejected and fall back to OpenAI's fields. **State explicitly that v2 and kosong now
differ on this rule** — kosong is untouched by decision, so the divergence is documented,
not silently harmonised.

**Acceptance**
- File parses as valid changeset frontmatter.
- The divergence sentence is present.

**Commit** — `docs(changeset): note the DeepSeek usage rule and the v2/kosong divergence`

---

## Task B0 — Prove tsdown `copy` recurses (blocking gate)

**Do** — before moving anything:
- Run a build of `packages/agent-core-v2` (and confirm `apps/kimi-code`'s copy entry
  resolves the same way).
- Inspect the produced `dist/` to see whether a nested directory under
  `model-adaptations/` survives.

**Acceptance**
- A concrete recorded result: recurses → proceed to B1; does not → stop, report, and
  switch to the fallback in B1-fallback.
- Do not proceed on assumption.

---

## Task B1 — Split adaptations by directory

**Files**
- Move `src/app/agentProfileCatalog/model-adaptations/deepseek.md` → `curated/deepseek.md`
- Move `deepseek-v3.md`, `claude-3.5-sonnet.md`, `gpt-4o.md` → `measured/`
- `src/app/agentProfileCatalog/modelAdaptations.ts`:
  - `LoadAdaptationInput` gains `kind: 'curated' | 'measured'`
  - `adaptationDirectoryCandidates` appends the kind's subdirectory
  - `loadCuratedAdaptation` passes `kind: 'curated'`
- `src/agent/profile/profileService.ts:913` opt-in path passes `kind: 'measured'`
  (`:908` needs no change — it delegates to `loadCuratedAdaptation`)

**B1-fallback** (only if B0 shows no recursion): keep files flat; add a
`curated-`/filename-prefix filter inside `loadFrom` driven by `kind`. Report which path
was taken.

**Acceptance**
- `npx tsc --noEmit -p tsconfig.json` exits 0.
- `npx vitest run test/app/agentProfileCatalog/modelAdaptations.test.ts` passes.
- `npx vitest run test/app/agentProfileCatalog/adaptationRender.test.ts
  test/app/agentProfileCatalog/profile-shared.test.ts
  test/agent/profile/adaptation-wire-name.test.ts test/features/deepseekAdaptation/` passes.
- `npx vitest run src/human/test/llm/modelFamily.test.ts
  src/human/test/llm/think-history.test.ts src/human/test/llm/tokens.test.ts` passes.
- New case: a file placed under `measured/` is not returned by the curated loader.

**Commit** — `refactor(agent-core-v2): express adaptation kind by directory instead of by filename coincidence`

---

## Task B2 — Re-run the build and confirm packaging

**Do** — rebuild; confirm `dist/` contains both `curated/` and `measured/`
(or, under the fallback, that the flat copy still carries all four files).

**Acceptance**
- Both subdirectories present in `dist/` (fallback: all four files present).
- If absent → fix packaging before continuing; do not land B1 alone.

---

## Task B3 — Changeset for Convergence B

**File** `.changeset/deepseek-adaptation-kinds.md`

**Do** — patch bumps, same package list. State: curated and measured adaptations now live
in separate directories; the loader resolves by kind; the coincidence they previously
relied on is gone. Note that behaviour is unchanged for users — curated `deepseek.md`
still injects by default, measured files still require `KIMI_MODEL_ADAPTATIONS=1`.

**Acceptance**
- Valid frontmatter; the "behaviour unchanged" note is present.

**Commit** — `docs(changeset): separate curated and measured model adaptations by directory`

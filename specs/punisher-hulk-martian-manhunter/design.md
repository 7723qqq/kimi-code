# Design — Two convergences for #1 and #4

## Verified constraints this design rests on

| Fact | Where | Consequence |
|---|---|---|
| v2 cannot import kosong | `check-import-boundaries.mjs:15,137` `KOSONG_PATH_RE`; ran the checker, it rejects | A converges inside v2, not across packages |
| Hooks/traits must not go into format | `docs/en/llm.md:71` Rejected Schemes | A cannot add a logger param to `parseOpenAIUsage` |
| `src/human/**` has zero logger imports | grep count = 0 | A does not thread `ILogger` into the llm layer |
| Same dir already factors a wire variant into its own module | `bases/openai/reasoning-key.ts` | Precedent for where A's new module goes |
| `${model_adaptation_section}` exists only in `system.md:83`, not `system.minimal.md` | read both | B's split does not change what lands in prompts |
| tsdown `copy` uses `{from, to}` on a directory | `packages/agent-core-v2/tsdown.config.ts:11-16`, `apps/kimi-code/tsdown.config.ts:27-32` | Recursion must be confirmed by a real build |

---

## Convergence A — usage semantics get one owner

### Ownership

`human/llm/requester/bases/openai/usage.ts` owns OpenAI-compatible usage semantics:
field recognition (including the DeepSeek variant), normalisation to `TokenUsage`, and
the consistency rule. `format.ts` becomes a forwarder that holds no semantics.

Placement follows the existing `reasoning-key.ts` precedent — a sibling module that
holds knowledge of one wire variant while `format.ts` only calls it.

### New module

`src/human/llm/requester/bases/openai/usage.ts`:

```ts
export interface OpenAICacheFields {
  readonly cached: number;
  readonly miss: number | undefined;
}

export function readOpenAICacheFields(usage: OpenAIRawUsage): OpenAICacheFields;
export function parseOpenAIUsage(usage: OpenAIRawUsage | null | undefined): TokenUsage | undefined;
```

`readOpenAICacheFields` is the seam: it recognises DeepSeek's top-level
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, falling back to OpenAI's
`cached_tokens` / `prompt_tokens_details.cached_tokens`, and applies the rule:

- `hit` present and `hit + miss > prompt_tokens` → fields disagree; return
  `{ cached: cached_tokens ?? prompt_tokens_details?.cached_tokens ?? 0, miss: undefined }`
- otherwise → `{ cached: hit ?? cached_tokens ?? details ?? 0, miss }`

`parseOpenAIUsage` composes that into `TokenUsage`, keeping today's shape:
`inputOther = miss ?? Math.max(promptTokens - cached, 0)`, `inputCacheCreation: 0`,
`raw: usage`.

### Changed files

- **New** `src/human/llm/requester/bases/openai/usage.ts` — semantics.
- `src/human/llm/requester/bases/openai/format.ts:126-142` — delete the body; import from
  `./usage` and re-export, so `#/llm/requester/bases/openai/format`'s public surface is
  unchanged for `requester.ts:37,168` and tests.
- `src/human/llm/requester/bases/openai/requester.ts` — no change required; verify it
  still resolves.

### Before / after

`{ prompt_tokens: 100, prompt_cache_hit_tokens: 5000, prompt_cache_miss_tokens: 0 }`

- Before: `inputCacheRead: 5000, inputOther: 0` — cache reads exceed total input.
- After: `inputCacheRead: 0, inputOther: 100` — fields rejected, OpenAI semantics used.

`{ prompt_tokens: 2011, prompt_cache_hit_tokens: 1792, prompt_cache_miss_tokens: 219 }`
(real capture, `deepseek-live-usage.test.ts:7`) is unchanged: 1792 + 219 === 2011, no
fallback.

### Tests

`src/human/test/llm/deepseek-live-usage.test.ts` — three new cases: sum exceeds, sum
equals, sum is less. Existing three cases must still pass.
`src/human/test/llm/usage.test.ts` must stay green (4 openai + 3 anthropic cases).

### Risks

Low. Pure function relocation plus one arithmetic rule; no signature change;
`format.ts` re-exports so no import site moves.

### Alternatives rejected

- **Delete v2's copy and call kosong `extractUsage`.** Cleanest ownership, but v2 cannot
  import kosong (verified). Would mean changing kosong or the lint rule — both out of scope.
- **Add a logger parameter to `parseOpenAIUsage` and thread it from `createOpenAIFormat`.**
  Directly contradicts `docs/en/llm.md:71` and would be the first logger in `src/human/**`.
- **Return a flag and log from `requester.ts`.** Sound, but requester also has no logger;
  wiring one there is a cross-layer change. Deferred, per R-out-of-scope.

---

## Convergence B — file kind becomes structural

### Ownership

`modelAdaptations.ts` is the sole owner of adaptation loading, and kind decides which
directory is searched. `modelFamily.ts` answers family, pricing, prompt shape — never
"which kind of file to read".

### Layout

```
model-adaptations/
  curated/deepseek.md
  measured/deepseek-v3.md
  measured/claude-3.5-sonnet.md
  measured/gpt-4o.md
```

`deepseek.md` is curated (hand-authored, injected by default through the reminder path).
The other three are measured probe output, reachable only under
`KIMI_MODEL_ADAPTATIONS=1`.

### Changed files

- `src/app/agentProfileCatalog/modelAdaptations.ts`:
  - `LoadAdaptationInput` gains `kind: 'curated' | 'measured'`.
  - `adaptationDirectoryCandidates` resolves `<dir>/curated` or `<dir>/measured` per kind.
  - `loadCuratedAdaptation` (added by commit #3) passes `kind: 'curated'`.
- `src/agent/profile/profileService.ts`:
  - `:908` curated path — already delegates to `loadCuratedAdaptation`, no change.
  - `:913` opt-in path passes `kind: 'measured'`.
- Packaging configs: `from` stays the `model-adaptations` directory; recursion is
  confirmed by a real build, not assumed.
- Tests: `test/app/agentProfileCatalog/modelAdaptations.test.ts` fixtures move to
  subdirectories; `:248` `SHIPPED` splits per kind; new case asserting the curated
  loader cannot read a file placed under `measured/`.

### Before / after

- Before: `deepseek.md` and `deepseek-v3.md` share one candidate chain; separation rests
  on the family prefix `deepseek` not equalling the filename `deepseek-v3`.
- After: physical separation. The curated loader never lists `measured/`.

### Risks

Medium — this is the only change that can be green locally and broken in production,
because tests pass `dir` and skip directory search.

Mitigation, in order:
1. Run a real build **before** moving files; record whether `copy` recursed.
2. Move files and re-run the build; confirm `dist/` has both `curated/` and `measured/`.
3. If `copy` does not recurse → fall back (approved): keep a flat directory and filter
   filenames by kind inside `loadFrom`. Report which path was taken.

### Alternatives rejected

- **Prefix-based filename convention (`curated-*.md`) in a flat dir.** Works without
  touching packaging, but kind stays a naming convention rather than structure, so a
  misnamed file silently crosses categories. Kept as the approved fallback, not the
  primary.
- **Kind inferred from `modelFamily` at load time.** Re-mixes family knowledge into
  loading, which is what Convergence B exists to separate.

---

## Changesets

Two entries, following `.changeset/deepseek-family-specialization.md`:

- **Convergence A**: usage semantics moved to a single module; fields that disagree are
  rejected. Must state that v2 and kosong now differ on this rule — kosong is untouched by
  decision, so the divergence is documented, not silently harmonised.
- **Convergence B**: curated and measured adaptations separated by directory; the
  coincidence they relied on is gone.

# The LLM module design guide

This page is the design guide for `packages/agent-core-v2/src/human/llm`. Read it before changing anything under that directory. It records the layering rules the module is built on and the reasons behind them, so a change that looks local does not quietly break a boundary the rest of the engine depends on.

## Layering

The LLM module is split into three layers, and imports only ever point one way.

```
human/llm            the pure kernel: messages, models, protocol shapes, requesters
human/llm/requester/bases/<protocol>   per-wire encoding and decoding
llm-adapter          the v2 compatibility boundary
```

- **`human/llm` is a pure kernel.** It never imports v2 domains (`app/`, `features/`, `state/`, `workspace/`, `_base/`, `llm-adapter`, …). This is enforced by `packages/agent-core-v2/scripts/check-import-boundaries.mjs`, which fails the build on a violation rather than leaving the rule to review. The kernel must stay loadable without the engine's DI container, assets, or configuration. The same rule is why the kernel declares its own log port in `human/log/log.ts` instead of reaching for `#/_base/log/log`: callers pass a logger in when they want the kernel to report something, and the kernel stays silent without one.
- **The `kosong` package is the frozen legacy kernel.** Nothing in `agent-core-v2` may import it; provider and request code lives in `human/llm`, and the v2 compatibility boundary is `llm-adapter`. The boundary check rejects the import path outright.
- **`#human/*` is the public kernel path.** Within the package, files outside `human/` reach into the kernel through `#human/...`; files inside it use `#/...` and that resolves inside the kernel root.

## The requester pipeline

Each protocol under `human/llm/requester/bases/` follows the same shape:

| File | Responsibility |
| --- | --- |
| `trait.ts` | Provider-specific hooks. Optional; an absent hook means "use the default". |
| `contract.ts` | The neutral wire and chunk types the trait and the format both speak. |
| `format.ts` | Request assembly, stream parsing, and the lowering entry point. |
| `lower.ts` | Message conversion, one neutral `Message` in, wire messages out. |
| `usage.ts` | Usage-field semantics for that wire. |
| `requester.ts` | Wiring: builds the client, calls `prepare<Protocol>Request`, executes the stream. |

Two rules keep this layer from turning into a knot:

1. **`format` and `trait` never import each other.** Both sides speak only the neutral types in `contract.ts`. The boundary check enforces this, because the mutual dependency that results otherwise is invisible until someone tries to change one side.
2. **`format`, `lower`, `patterns`, and `reasoning-key` are internal to the pipeline.** Only `bases` code and its tests may import them; everything else speaks `contract`, `trait`, or `requester`. A caller that needs new behaviour should find it on the trait or on the public requester surface.

## Where a rule belongs

Choosing the right home for a new rule is most of the design work. Three questions decide it:

- **Is it a fact about the wire, or about one vendor's preference?** Wire facts (how a field is named, what a valid payload looks like) belong in `format`/`lower`. Vendor behaviour that may vary by model belongs on the family table or the trait.
- **Does it depend on the request shape rather than on provider identity?** A requirement like "when the request carries `tools`, the prior reasoning must be replayed in full" is triggered by what the request contains, not by who serves it. Those belong on `llm/modelFamily.ts` and are evaluated from the request itself. Modelling them as trait hooks hides them behind a provider registration that may not exist.
- **Is it a per-model constant?** Pricing shapes, effort vocabularies, and prompt shapes live on the family table in `human/llm/modelFamily.ts`. Keep wire encoding out of that table — it belongs to the protocol bases.

## Model families

`human/llm/modelFamily.ts` is a table of per-family constants, resolved by matching the normalized model name against declared prefixes. Longest prefix wins, so `xopdeepseek*` and `deepseek*` can coexist.

Each entry may carry:

- `promptShape` — selects which system-prompt template the profile catalog renders. `minimal` templates intentionally reference few variables; see the note on dropped variables below.
- `imagePricing` — the vision token accounting constants. These are heuristics derived from live-endpoint calibration, not published formulas. The measurements behind them (formula → live endpoint, and the deltas) are recorded in the changeset that shipped the formula; `scripts/measure-image-tokens.cjs` is the arbiter, so run it against a live endpoint and recalibrate both sides when they disagree. Treat the numbers as estimates and keep `fallbackTokens` (dimensions unknown) independent of `tokenCap` (grid ceiling) even when they hold the same value: an endpoint change to either must not move the other.
- `reasoningEffort` — the effort value to send when the history already carries reasoning.
- `thinkingHistory` — request-shape-driven reasoning rules: `fullEchoWithTools` for families that require the whole chain of thought whenever `tools` is present, and `ignoredWhileThinking` for sampling parameters the endpoint accepts but does not act on.

Two of those rules are worth stating outright, because both are documented as hard requirements upstream rather than as preferences:

- **Full reasoning replay.** DeepSeek requires `reasoning_content` to be passed back in full on every request that carries `tools`, including turns where no tool was called; a request that omits it fails with HTTP 400. Because the trigger is the request shape, the check lives in `fullReasoningEchoRequired(model, hasTools)` and is evaluated by the requester from `tools.length`, not from a trait hook.
- **Silently ignored sampling parameters.** Thinking mode accepts `temperature`, `presence_penalty` and `frequency_penalty` without erroring and without acting on them. They are dropped at the last point where the request shape is still visible, and only the names the family itself declares are touched; every other key passes through untouched.

The effort vocabulary is a many-to-one collapse rather than a set mismatch (`minimal`→low, `low`→low, `medium`→high, `high`→high, `xhigh`→high, `max`→max), so several requested values resolve to the same actual effort. Only the history default is consumed today.

`maxOutputDefaults` carries the three output ceilings a family wants applied when the caller sets none (non-thinking, thinking, thinking at `max` effort). The requester applies it only as the last fallback — an explicit caller cap and a provider trait both win — and clamps it to the remaining context window.

## Usage accounting

Usage parsing has one home per wire, and its rules are about what the fields mean, not about who sent them. `human/llm/requester/bases/openai/usage.ts` reads the DeepSeek cache split first (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`), falls back to the OpenAI-shaped cached counts (`cached_tokens`, `prompt_tokens_details.cached_tokens`), and rejects a split whose parts cannot both be true: a hit+miss sum **greater** than `prompt_tokens` is self-contradictory and the OpenAI fields are used instead. A sum merely **less** than `prompt_tokens` is not an error — an endpoint may report only part of the split. A rejected `prompt_cache_miss_tokens` is kept on the parsed result so reporting can still show it after the field itself is cleared.

The same rule also exists in `packages/kosong/src/providers/openai-common.ts`, because `kosong` is a separate frozen kernel and neither package may import the other. When changing the rule, change both. `packages/kosong/test/cache-field-parity.test.ts` feeds identical payloads to both implementations and fails if they disagree — it is the only thing keeping the two copies honest, so extend its case table when you extend the rule.

## Prompt shape and dropped variables

`renderPrompt` substitutes the variables a template references and leaves everything else untouched, so a variable the active template never mentions disappears silently. The profile catalog compensates:

- `renderSystemPromptResult` and `renderPromptTemplateResult` return `droppedVars`, listing supplied-but-unreferenced variables. Callers log them. The list is the only signal that content was lost: the renderer drops unknown variables by design because the same helper serves several templates.
- The `minimal` prompt shape keeps only the persona and the working directory. Under it, AGENTS.md content, skill listings, plugin sections, and the model-adaptation section never reach the prompt. Anything that depends on that content being present must check `droppedVars` rather than assume delivery.
- Because the AGENTS.md body never reaches a `minimal` system prompt, the injection bookkeeping must not mark those paths as already delivered: doing so would suppress the separate reminder that points the model at them. Seed only the paths the template actually carried; everything else stays eligible for that reminder.
- Some templates reference a composed block (`skills_section`) instead of the raw variable it was built from (`skills`). A template that names the block has delivered the content even though the raw name never appears, so the raw variable must not be reported as dropped. The block→variable pairing is declared explicitly rather than inferred from names, and a block composed from something that is not itself a variable (`plugin_sections`, `model_adaptation_section`) has nothing to pair with.
- `valueDelivery` classifies every non-empty variable the profile did not carry: `reminder` for content a separate channel delivers (the model adaptation), and `intentionally_omitted` with a reason for content the profile leaves out on purpose (AGENTS.md, skills, plugins, additional directories). A successful render therefore has no unclassified non-empty variable, and an unresolved `${name}` produces a `warnings` entry instead of counting as delivered.
- `contractDelivery` reports the six core behavior rules from `behaviorContract.ts` per profile: the full shape delivers all six in the system prompt; the minimal shape delivers two in the template and hands the other four to the adaptation reminder, or marks them `intentionally_omitted` when the family has no reminder channel.

## Model adaptations

`app/agentProfileCatalog/model-adaptations/curated/` holds hand-authored family guidance, and every family resolves to it through the prefix the family table declares. A versioned or provider-qualified id (`deepseek-v4-pro`, `xopdeepseekv32`, `workbuddy/deepseek-v4.1-flash`) therefore needs no adaptation file of its own.

There is deliberately no second kind of adaptation file. A `measured/` directory existed and was removed with the mechanism that read it, because nothing in this repository writes such files: `scripts/prompt-optimizer probe` writes JSON into the gitignored `reports/` directory, and no code path targets `model-adaptations`. Every file that shipped there had hand-written numbers presented as probe output, for models that had already been retired or had never existed as wire ids. If a real producer is ever built, reintroduce the directory *together* with the code that writes it — a file without a producer is an unverifiable claim.

Files are capped at 32 KiB. An oversized file is cut at a `##` section boundary rather than dropped, because these files are hand-written and split by `##`: cutting at a boundary keeps whole guidance sections, while dropping the file because its last paragraph ran long loses all of them. The beginning of the file is where the most important guidance sits, so when even the first section does not fit the cut falls back to a hard truncation at the limit and the caller still gets that beginning rather than nothing.

The boundary scan tracks fenced code blocks. A `##` line inside a fence is quoted content, not a section boundary: these files quote example prompts in fences, and treating a quoted heading as a boundary could cut inside the block, leaving the fence unterminated and the remainder of the guidance framed as code. Fence spans are recorded as spans rather than open offsets so the hard cut can ask whether the limit falls inside *this* fence, including one that closes further down the file. A fence that opens at the very beginning leaves nothing to keep, so that case falls through to the plain cut rather than returning an empty string. Indented code blocks need no handling — their lines start with whitespace and cannot match a heading.

The two delivery channels are complementary, and a family is served by exactly one:

- **Reminder injection** — for families whose `promptShape` is `minimal`. Those templates have no `${model_adaptation_section}` placeholder, so the prompt path could only load the file and have the renderer report it as a dropped variable. `adaptationDeliveredByReminder` names this case, and `features/deepseekAdaptation` implements it.
- **System-prompt section** — for any future family that carries curated guidance without the minimal shape.

`loadCuratedAdaptation` and `hasCuratedAdaptation` gate on the family declaring `curatedAdaptation`, so an unregistered model is never given guidance.

The reminder is composed rather than copied: `renderCuratedAdaptation` prepends the four core contract clauses the minimal shape delegates, states that the guidance is hand-written rather than measured, and then appends the curated body under a `## Working rules delegated by the minimal prompt` section. A minimal-shape session therefore receives the same six-rule contract as a full one, split across the two channels instead of duplicated in both.

The reminder side caches the **in-flight load** per wire name rather than the settled value. The provider is async and the reminder service can ask for it during any step, so two callers can overlap before either write completes; caching the promise means the file is read once no matter how many callers race it. A resolved `undefined` is stored as a real entry, so a model without an adaptation does not re-read the directory on every step.

The text is also derived from the **wire name**, which does not change mid-session, rather than re-derived from the conversation each step. Re-deriving cost a file read per step and re-injected at the end of the context repeatedly, which is where a cache prefix is most likely to be invalidated; the value only needs rebuilding once compaction has dropped it.

## Testing

Tests for this module live in `src/human/test/llm/` (kernel-level) and `test/` (engine-level). Prefer asserting the wire shape and the resolution order over asserting that a function was called: the bugs this module has actually shipped were precedence errors and silent drops, and both are invisible to call-count assertions.

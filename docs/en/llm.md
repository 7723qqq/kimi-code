# The LLM module design guide

This page is the design guide for `packages/agent-core-v2/src/human/llm`. Read it before changing anything under that directory. It records the layering rules the module is built on and the reasons behind them, so a change that looks local does not quietly break a boundary the rest of the engine depends on.

## Layering

The LLM module is split into three layers, and imports only ever point one way.

```
human/llm            the pure kernel: messages, models, protocol shapes, requesters
human/llm/requester/bases/<protocol>   per-wire encoding and decoding
llm-adapter          the v2 compatibility boundary
```

- **`human/llm` is a pure kernel.** It never imports v2 domains (`app/`, `features/`, `state/`, `workspace/`, `_base/`, `llm-adapter`, …). This is enforced by `packages/agent-core-v2/scripts/check-import-boundaries.mjs`, which fails the build on a violation rather than leaving the rule to review. The kernel must stay loadable without the engine's DI container, assets, or configuration.
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
- `imagePricing` — the vision token accounting constants. These are heuristics derived from live-endpoint calibration, not published formulas. Treat the numbers as estimates and keep `fallbackTokens` (dimensions unknown) independent of `tokenCap` (grid ceiling) even when they hold the same value.
- `reasoningEffort` — the effort value to send when the history already carries reasoning.
- `thinkingHistory` — request-shape-driven reasoning rules: `fullEchoWithTools` for families that require the whole chain of thought whenever `tools` is present, and `ignoredWhileThinking` for sampling parameters the endpoint accepts but does not act on.

## Usage accounting

Usage parsing has one home per wire, and its rules are about what the fields mean, not about who sent them. `human/llm/requester/bases/openai/usage.ts` reads the DeepSeek cache split first, falls back to the OpenAI-shaped cached counts, and rejects a split whose parts cannot both be true.

The same rule also exists in `packages/kosong/src/providers/openai-common.ts`, because `kosong` is a separate frozen kernel and neither package may import the other. When changing the rule, change both. `packages/kosong/test/cache-field-parity.test.ts` feeds identical payloads to both implementations and fails if they disagree — it is the only thing keeping the two copies honest, so extend its case table when you extend the rule.

## Prompt shape and dropped variables

`renderPrompt` substitutes the variables a template references and leaves everything else untouched, so a variable the active template never mentions disappears silently. The profile catalog compensates:

- `renderSystemPromptResult` and `renderPromptTemplateResult` return `droppedVars`, listing supplied-but-unreferenced variables. Callers log them.
- The `minimal` prompt shape keeps only the persona and the working directory. Under it, AGENTS.md content, skill listings, plugin sections, and the model-adaptation section never reach the prompt. Anything that depends on that content being present must check `droppedVars` rather than assume delivery.

## Model adaptations

`app/agentProfileCatalog/model-adaptations/` holds two kinds, split by directory:

- `curated/` — hand-authored family guidance. Loaded by default.
- `measured/` — probe output. Loaded only when `KIMI_MODEL_ADAPTATIONS=1`.

`resolveModelAdaptationText` owns the precedence in one place: measured output outranks the curated family file when the flag is set, and curated is all that is reachable when it is not. Both the system-prompt path and the reminder-injection path call it, so they cannot disagree about which file a model receives. Families whose prompt shape is `minimal` have no `${model_adaptation_section}` placeholder, so their guidance is delivered by the reminder injection instead — see `features/deepseekAdaptation`.

## Testing

Tests for this module live in `src/human/test/llm/` (kernel-level) and `test/` (engine-level). Prefer asserting the wire shape and the resolution order over asserting that a function was called: the bugs this module has actually shipped were precedence errors and silent drops, and both are invisible to call-count assertions.

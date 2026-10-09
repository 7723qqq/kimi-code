---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Unify model-family handling behind a single source of truth, and make model adaptations actually reachable.

- `model-family`: add `human/llm/modelFamily.ts` (family resolution, per-family image token pricing) and re-export it through the `llm-adapter` contract boundary. First registered family: `deepseek`, whose prefixes also cover the astron-hosted ids (`xopdeepseek*`).
- `tokens`: collapse the three duplicate estimators (`llm-adapter/contract/tokens`, `human/persist/v2/fold`, `human/agent/context-usage`) into `human/llm/tokens.ts`; the adapter module now re-exports it. `estimateTokensForContentPart` accepts optional family image pricing. Estimator behaviour is unchanged without pricing; the former `context-usage` estimator now also counts tool calls on non-assistant roles and stringifies `null` arguments, matching the adapter implementation (compaction budgets for tool-heavy histories become slightly more conservative).
- `model adaptations`: match by candidate list (exact stem → family prefix) instead of a single exact file name, and resolve the wire name first with the alias as fallback. `bind()` now supplies the model being bound, so an opt-in (`KIMI_MODEL_ADAPTATIONS=1`) actually injects the adaptation on the binding path — previously the alias was read before the profile bind wrote it, so injection never happened.
- packaging: copy `model-adaptations/*.md` into the built artifacts and search upward from the module directory, so the adaptations are reachable from both the package `dist/` and the bundled CLI (`dist/chunks/`).

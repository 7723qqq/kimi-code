---
"@moonshot-ai/agent-core-v2": patch
---

Model adaptations carry hand-authored guidance only; the unproduced "measured" kind is removed.

- `adaptation`: `model-adaptations/measured/` and everything that read it are gone — `AdaptationKind`, the `kind` parameter on `loadModelAdaptation`, `resolveModelAdaptationText`, `renderAdaptationSection`, and the `KIMI_MODEL_ADAPTATIONS` opt-in gate. The directory held three files whose headers say "no code in this repository writes this file", and that is accurate: `scripts/prompt-optimizer probe` writes JSON into the gitignored `reports/` directory, and nothing in the repository targets `model-adaptations`. The figures they carried (`negation compliance: 0.44 (critical)` and the like) reused the probe's dimension names with hand-written values, presented as probe output.
- `adaptation`: the three files also named models that no longer exist. `gpt-4o` was retired from ChatGPT with no API guarantee; `claude-3.5-sonnet` used a dotted spelling that can never match Anthropic's hyphenated ids (`claude-3-5-sonnet-20241022`), so it was unreachable even while the model was live; `deepseek-v3` was never an API model name at all — DeepSeek served V3 as `deepseek-chat`, retired 2026-07-24, and this repository's V3.2 is `xopdeepseekv32`.
- `adaptation`: `adaptationDeliveredByReminder` replaces `isCuratedAdaptationModel`. The new name states what the predicate decides — that the family's guidance travels by per-agent reminder rather than as a prompt section — instead of asserting a condition about the file kind. `hasCuratedAdaptation` covers the family-declares-guidance half on its own.
- `adaptation`: `adaptationDirectoryCandidates` and `loadModelAdaptation` no longer take a kind; every family resolves through the prefix its family entry declares, so a versioned or provider-qualified id needs no file of its own.
- `adaptation`: `profileService` resolves only the curated file, and skips families that the reminder channel owns, so a family is served by exactly one channel.
- `docs`: `docs/en/llm.md` records why the kind has no producer and asks that a producer be added together with the directory if one is ever built.

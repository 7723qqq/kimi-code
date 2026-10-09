---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Curated and measured model adaptations now live in separate directories, so which kind a model gets is decided by structure instead of by a naming coincidence.

- `model adaptations`: `agentProfileCatalog/model-adaptations` splits into `curated/` (the hand-authored DeepSeek family guidance, injected by default) and `measured/` (`deepseek-v3`, `claude-3.5-sonnet`, `gpt-4o` — probe output, still reachable only under `KIMI_MODEL_ADAPTATIONS=1`). `loadModelAdaptation` takes a `kind`, and the curated loader can no longer list the measured directory.
- Previously both kinds shared one candidate chain, separated only because the family prefix `deepseek` happened not to equal the versioned filename `deepseek-v3`. A family prefix that ever matched a versioned filename would have pulled unverified probe output into the default-on curated path.
- Behaviour is unchanged for users: the curated DeepSeek guidance still reaches the model through its reminder injection, and measured files still require the opt-in. The built artifacts carry both subdirectories.

# Model Adaptation: gpt-4o
#
# Not reproducible: no code in this repository writes this file, so the
# figures below have no recorded provenance. Treat them as unverified.
# Loaded into the system prompt by agentProfileCatalog/modelAdaptations.ts
# when gpt-4o is the active model, and only with KIMI_MODEL_ADAPTATIONS=1.
#
# Strengths:
#   - Priority reasoning: 0.92
#   - Numeric constraints: 0.95
#   - XML tag injection: 0.88
#
# Weaknesses:
#   - Few-shot sensitivity: +8% (mild)
#   - Output verbosity: tends to over-explain

## Conciseness Reinforcement Patch

This model tends to be verbose. Add extra emphasis:
- Reinforce "≤5 lines for simple tasks" with a concrete example
- Add: "If your response exceeds 10 lines for a simple task, you are being too verbose. Trim."

## No Additional Patches Needed

gpt-4o has strong instruction following across all tested dimensions.
The base system.md is sufficient without structural changes.

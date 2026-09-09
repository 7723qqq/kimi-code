---
"@moonshot-ai/kimi-code": patch
---

Delegate session-title derivation to the engine (`sessionGenerateTitle` with `first_turn` / `user_prompts` sources; `digest` fails fast), so generated titles follow the live cross-turn history.

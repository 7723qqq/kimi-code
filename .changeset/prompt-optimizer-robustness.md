---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": minor
---

Rewriting a drafted prompt with Ctrl+P now marks a draft or conversation that was too long to consider in full, backs an over-long rewrite up to a sentence boundary instead of cutting it mid-sentence, and reports a second Ctrl+P pressed while a rewrite is still running instead of starting another. `session.optimizePrompt` now takes `recentTurns` as an array of strings and caps it to the most recent turns itself.

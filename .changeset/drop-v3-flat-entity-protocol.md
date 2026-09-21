---
"@moonshot-ai/kimi-code": patch
---

Drop the v3 flat-entity protocol surface and return kimi-inspect to the v1 transcript model, following upstream's revert of it in 2.0.2. The engine no longer serves `/api/v3/ws` or the turn-paged history route; the inspector's chat view reads `transcript.reset` / `transcript.ops` over `/api/v1/ws`, and its audit panel now records op batches instead of entity messages.

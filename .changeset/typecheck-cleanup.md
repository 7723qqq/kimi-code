---
'@moonshot-ai/agent-core': patch
'@moonshot-ai/agent-core-v2': patch
---

Fix the packages so `pnpm typecheck` passes again.

- `buildRequestOptions` now takes an optional `signal` (both engines) so callers that omit it compile after oxlint strips the redundant `undefined`.
- `agent-core-v2`: `snipLargeToolResults` returns a mutable copy instead of the readonly input; the LLM-request trace callback is invoked with an explicit `undefined` trace id; `plainObjectToToml` accepts an omitted `raw` base object.
- Refresh stale test stubs/signatures across the two packages to match current interfaces.

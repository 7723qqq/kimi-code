---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Rejected usage cache fields are now reported instead of falling back silently.

- `usage`: `parseOpenAIUsage` takes an optional log port and warns when it rejects a DeepSeek cache split for exceeding `prompt_tokens`, including the reported hit/miss and the prompt total. Without a logger it stays silent, so nothing changes for callers that pass none.
- `llm logging`: the llm kernel gains `src/human/log/log.ts`, a minimal `LlmLogger` port it defines itself. `human` is the pure kernel and must not import v2 domains, so it cannot reach `#/_base/log/log`; this keeps that boundary while letting callers opt into the kernel's warnings. The port is threaded construction-time through `createOpenAIRequester` and `ProtocolAdapterRegistry` (which supplies `ILogService`), not per-parse, so the format stays free of trait/hook wiring.
- `tests`: the protocol registry now needs `logService` wherever it is constructed, so test hosts that had no logger seed one explicitly (`SILENT_TEST_LOGGER` exported from `src/_base/di/test.ts`). Shared scaffolding is untouched, and where a test registers its own `ILogService` — as the cross-scope log test does — that binding still wins.

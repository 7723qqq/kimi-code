---
'@moonshot-ai/kimi-code': minor
---

Bridge `AskUserQuestion` to ACP clients. When the client advertises `elicitation.form`, the question set goes through `elicitation/create` (native multi-question and multi-select: single-select becomes a `string` + `oneOf`, multi-select an `array` + `items.anyOf`); otherwise, and on any `elicitation/create` failure, it falls back to the `session/request_permission` single-select bridge with the `q{n}_*` option-id namespace. Answers round-trip into the engine's `answers` map, and a decline / cancel / skip resolves to the canonical "user dismissed" response instead of fabricating an answer. Adds `acp/question.rs` (the pure mappers, ported from the retired `agent-core-v2` `question.ts`) and the `clientCapabilities.elicitation.form` field.

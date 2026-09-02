---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Native `resume` for foreground subagents: after a foreground `Agent` call completes, the engine keeps the conversation, and a follow-up `resume` call with that agent id continues it natively under the same profile policy (with full lifecycle events, timeout and cancellation semantics). Unknown resume ids still fall back to the host, which owns v2's persistent-scope resume. Also wires the stdio session entry's cancellation into the event-driven parent-cancel signal — the last cancellation gap — and corrects the record: `nativeTools` already defaults to true. Call-level `model` overrides, `fork` and background execution remain host-owned pending model-catalog pushdown design.

---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix `subagentTool depends on subagentBackendService which is NOT registered` at startup: the Session-scoped `SubagentBackendService` self-registers via a module side effect, but the module was never imported by the domain assembly (`src/index.ts`), so the registration never ran in the bundled CLI and the Agent tool failed DI resolution on every session create. Package tests imported the module directly and masked the gap.

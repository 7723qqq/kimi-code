---
"@moonshot-ai/agent-core-v2": minor
---

Add an optional `fork` parameter to the Agent and AgentSwarm tools, gated behind the new `KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK` experimental flag (default off).

When the flag is enabled and `fork: true` is passed, the spawned subagent inherits the calling agent's profile, model, tool set, and completed conversation history via `IAgentLifecycleService.fork`, so the prompt prefix cache is reused across the fork. Fork rejects combination with `subagent_type`, `model`, or `resume` (fork inherits the first two and cannot target an existing agent).

The `fork` field is stripped from the exposed tool schema when the flag is off, so the change has no effect on tool-surface hashes or downstream tool calls until the flag is enabled.

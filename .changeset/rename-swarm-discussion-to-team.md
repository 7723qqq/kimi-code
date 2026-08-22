---
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-i18n": minor
---

Rename the "Swarm Discussion" feature to "Team". The `SwarmDiscussion` agent tool is now `Team`, the `/discuss` slash command is now `/team`, and the `toolsV2.discussion.*` / `tui.messages.discuss*` locale keys are renamed accordingly. `AgentSwarm` and swarm mode are unaffected; the tool's `mode: "discussion" | "debate"` input semantics are preserved.

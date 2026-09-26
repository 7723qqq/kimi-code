---
"@moonshot-ai/kimi-code": patch
---

Stop subagent reasoning from being shredded into the main transcript. The engine stamps a subagent's deltas with a `subturn-` turn id and the host attributes them to the active subagent, but the TUI appended every `thinking.delta` / `assistant.delta` to the main transcript's single buffer regardless of source. With two subagents running, the main agent's reasoning and both subagents' reasoning interleaved chunk by chunk inside one block. Subagent deltas are now dropped on the main transcript's channels — their progress is already shown by the subagent's own activity row.

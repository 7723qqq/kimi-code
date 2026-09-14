---
"@moonshot-ai/kimi-code": patch
---

Stop showing degenerate thinking loops. A model that gets stuck repeating a phrase in its reasoning now has the rest of that thinking block dropped from the display instead of streaming the loop to the terminal; the answer that follows is untouched, and the block still round-trips to the provider intact. Turn it off with `KIMI_AGENT_THINKING_GUARD=0` or `[experimental].thinking_repeat_guard = false`.

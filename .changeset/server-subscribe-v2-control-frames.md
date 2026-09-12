---
'@moonshot-ai/kimi-code': patch
---

Accept the transcript WebSocket control frames on the native server. `subscribe_v2` / `unsubscribe_v2` are now parsed and acknowledged, and a `subscribe_v2` for a live session attaches it to the event lane and emits a `transcript.reset` baseline (the reconstructed `AgentTranscriptSnapshot`) for every agent with a non-`off` grade (`*` maps to the main agent). `transcript.ops` incremental frames are defined in the wire layer; live op emission remains a follow-up.

---
"@moonshot-ai/kimi-code-sdk": patch
---

A damaged agent journal no longer erases a session's history, three written settings are readable again, and an unknown error code from the wire is reported instead of thrown on.

One unparseable line in an agent's `wire.jsonl` used to make the whole read throw, which the caller turned into an empty replay: a resumed session showed no history, and its tool store disagreed with the engine that had restored the same session. Reading now stops at the damaged line, keeps the records before it, and logs where it stopped; only damage on the first line still yields an empty replay.

`getConfig()` now returns `github`, `extraAgentDirs` and `agent`, which could already be written through `setConfig` but read back as unset.

An error payload whose code this build does not declare is restated as `internal`, with the unknown code and its message logged. Previously the payload's code was trusted verbatim, so re-serializing that error threw instead of returning a payload and the caller lost both the original code and the message.

---
"@moonshot-ai/kimi-code": patch
---

Make every request to the opencode free tier pass the gateway's shape check, not just the tool-calling ones. The zen gate rejects a request unless it streams and its `tools` list carries a lowercase `bash` and `read`; the adapter only renamed the engine's `Bash` / `Read` entries, so the requests that carry no tools at all — the compaction summarizer and the title generator — were a guaranteed 403, which the user saw as "compaction cancelled". The adapter now forces `stream: true` and injects those two names as explicitly non-callable placeholders when they are missing, and leaves everything else (tool names beyond the pair, `reasoning_effort`, messages) untouched.

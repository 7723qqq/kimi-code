---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Stop hanging on large command output, and make a prompt rewrite cancellable. A command whose stdout exceeded the pipe buffer could block forever when the caller awaited the process before reading the stream: the buffered reader paused its source and only resumed when a consumer asked for data, so the child blocked in write() and never exited. The source now keeps moving on a short timer when nobody is reading, so the child finishes and the output waits in the buffer. Separately, `Session.optimizePrompt` accepts a `signal` so a rewrite — a full model round-trip — can be abandoned instead of leaving the editor marked busy with no way to give up.

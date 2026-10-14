---
"@moonshot-ai/kimi-code-sdk": patch
---

A broken log sink retries on a backoff instead of once per line. When a write failed, the drain put the unwritten lines back and the next `enqueue` immediately queued another full drain attempt, so a permanently failing sink (a full disk, an AV-blocked path) re-attempted the whole pending buffer for every subsequent log line. Automatic drains are now gated by an exponential `nextAttemptAt` (1 s doubling to 30 s, reset on the first success), checked both when a drain is scheduled and when it reaches the queue head — a burst queued before the first failure is observed must not each run its own attempt. Only the automatic retry is gated: `flush`, `close` and `flushSync` still always attempt, so shutdown can report what stayed buffered rather than silently dropping it.

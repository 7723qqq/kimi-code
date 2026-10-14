---
"@moonshot-ai/minidb": patch
---

A cluster read stats one fewer file. The shard fingerprint included `CURRENT`, which cannot change the wal-only verdict (it is deliberately excluded from that decision) and whose own change already resolves to keeping the cached reader through the catch-up path — so the stat was paid on every read without being able to alter the outcome. It is filtered out of the fingerprint, taking a read from six stats to five. The stronger guarantee in this file is untouched: a read that starts after another process's write has resolved still observes it, which is why a short-TTL fingerprint cache was rejected instead.

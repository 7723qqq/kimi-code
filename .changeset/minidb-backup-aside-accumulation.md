---
'@moonshot-ai/kimi-code': patch
---

Harden the embedded local database: interrupted or failed backups no longer leave stray copies or destroy the previous backup, the write lock is released on exit and cannot be acquired twice, and a lock directory that cannot be listed or inspected no longer waits forever.

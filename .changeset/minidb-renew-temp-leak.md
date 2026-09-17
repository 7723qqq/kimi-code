---
'@moonshot-ai/kimi-code': patch
---

Stop leaving a `db.lock.tmp-*` file behind every time a lock renewal cannot land. A renewal that exhausted its Windows retry window still left its temp file on disk, and the open-time stale-temp sweep intentionally never matches lock temps (they can belong to a live process), so the leftovers accumulated in the data directory.

---
"@moonshot-ai/kimi-code": patch
---

Make the staged self-updater engine-aware: a Bun packaged binary now downloads the release's Bun build from the manifest's optional `bun` section and refuses to silently swap itself to the Node SEA binary when that release ships none.

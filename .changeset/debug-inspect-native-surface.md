---
'@moonshot-ai/kimi-code': patch
---

Fix the kimi-inspect debug surface served by the native engine. Session/workspace snapshots now answer the inspector's contract shapes (`sessionId`/`workspaceId`/`cwd`, `binding`/`available`/`runtime`, `metadata`/`lifecycle`/`runtimes`), missing sessions and workspaces return an honest 404, and unknown debug RPC methods return 404 instead of a fake `{ "status": "ok" }` success — the DI/debug panels get truthful empty results for the read methods they call.

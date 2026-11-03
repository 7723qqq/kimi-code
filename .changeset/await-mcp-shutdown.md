---
"@moonshot-ai/kimi-code": patch
---

Shut MCP servers down deterministically when a workspace is torn down: workspace disposal now waits for MCP shutdown before releasing the workspace, stdio servers that ignore SIGTERM are force-killed after 5 seconds, and stdio probes hold the workspace lease so a concurrent workspace teardown cannot invalidate the probe mid-flight.

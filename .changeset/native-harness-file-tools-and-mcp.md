---
'@moonshot-ai/kimi-code': patch
---

Fix five defects that made the native harness's file tools and MCP startup unusable: Git Bash and Cygwin paths are bridged to their Windows spelling before resolution, unresolvable paths and bad arguments are reported as tool errors instead of declining the call, and MCP servers configured without an explicit transport are connected again with `/mcp` reporting the real tool count.

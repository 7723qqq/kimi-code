---
'@moonshot-ai/kimi-code': patch
---

Fix five defects that made the native harness's file tools and MCP startup unusable.

Git Bash / Cygwin paths (`/g/kimi/...`, `/cygdrive/c/...`) are now bridged to their Windows spelling before resolution — they carry a root but no drive prefix, so `Path::is_absolute` was false and `join` replaced the root, turning `/g/kimi/x` into `G:/g/kimi/x` and making the file "disappear". The bridge is the full v2 `shellPathBridge`: drive-letter forms are rewritten lexically, and a root-relative path the lexical pass cannot place (`/tmp/x`, `/usr/bin`) goes through `cygpath -w` next to the probed shell, so a path Bash wrote is the path Read finds. The stale-write gate resolves through the same bridge, so its map key and the writer's target name the same file.

A path the engine cannot resolve, a mistyped argument, an unknown `type` name, an unknown `mode`, and a file that is not readable text are now reported as tool errors instead of declining the call: the native harness has no host tool runtime, so declining surfaced as `tool "Grep" is host-owned and not yet wired on the native harness` rather than naming what was wrong.

MCP servers configured in the standard shape (`{"mcpServers":{"x":{"command":"…","args":[…]}}}`) are connected again — the transport is inferred from `command`/`url` when the entry omits it, as v2 did, instead of the entry being skipped silently. `/mcp` reports the real tool count: the engine's `tool_count` is mapped onto the public `toolCount` field.

---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

The plugin surface now works on the native engine. `/plugins` (list, install, enable/disable, remove, info, reload) and plugin-contributed slash commands were unreachable: `installPlugin`, `listPlugins` and `getPluginInfo` fell through to the base class and threw `has not wired RPC method`, while `listPluginCommands` / `listPluginCommandsGlobal` returned a hardcoded `[]` because nothing read a plugin manifest.

The engine now owns the whole path. `PluginManager` gained manifest reading (`kimi.plugin.json`), plugin-root resolution from the catalog `source`, command loading with the same minimal frontmatter the skill loader uses (`name` falls back to the file stem, `description` to the first body line), per-plugin MCP server enable/disable, and a reload that reports what changed. Nine `napi` exports expose it (`initPluginStore`, `pluginList`, `pluginInstall`, `pluginInfo`, `pluginSetEnabled`, `pluginSetMcpServerEnabled`, `pluginRemove`, `pluginReload`, `pluginCommands`), and the SDK wires all nine plugin methods to them.

The registry is the app-scope engine store (`<data_dir>/sessions.db`, the same database the hosted server opens), so the CLI and `kimi web` read one install state. A plugin whose catalog `source` is a URL has no local content to read and contributes nothing until it is fetched to disk; `getPluginInfo` reports `state: "remote"` for it.

The installed list and `/plugins` act on the same plugin identity the engine resolves: installing from a plugin directory keys the record by the manifest's own `name` (never the path handed over), the list carries the state and skill/MCP/command counts the panel renders, removing a plugin also drops its managed copy so it cannot keep contributing, and `/plugin:<name>` dispatch reaches the engine instead of failing as an unwired RPC.

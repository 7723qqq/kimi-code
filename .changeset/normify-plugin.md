---
"@moonshot-ai/kimi-code": minor
---

Merge the Normify architecture-diagram system (ported from `yan-mc/dsh-normify` v0.5.4) as a built-in default plugin:

- `packages/normify` hosts the engine — 30 `normify_*` tools, zero-tolerance validation, deterministic compilation, and the single-file interactive renderer — with the tool layer made host-agnostic and exposed over MCP (`normify-mcp`) and a CLI (`normify`).
- The `normify` official plugin (normify-gen skill + the MCP server) is embedded in the CLI distribution and seeded into the plugin registry on first `ensurePluginStore` call: zero install, enabled by default. An explicit disable is preserved, a removal is remembered via an opt-out marker, and re-enabling clears it.
- Plugin stdio servers declared with `command: "node"` are re-executed inside the host runtime on packaged installs (`<exe> __plugin_run_node <entry>` via the new `initPluginStore` `nodeRunner` argument), so the built-in plugin works without a system Node.js. Source and node-dist runs keep spawning `node` as declared.

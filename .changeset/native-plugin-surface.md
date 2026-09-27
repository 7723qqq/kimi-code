---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

The plugin surface works on the native engine: `/plugins` (list, install, enable/disable, remove, info, reload) and plugin-contributed slash commands are reachable, the CLI and `kimi web` share one install state, and a plugin with no local content reports itself as remote instead of silently contributing nothing.

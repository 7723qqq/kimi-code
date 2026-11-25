---
'@moonshot-ai/core': patch
'@moonshot-ai/agent-core-v2': patch
---

Keep deferred tool declarations out of the encoded request instead of dropping them in the encoder. The ToolSelect resolver now removes deferred entries from the resolved top-level tools when the model supports dynamic loading, and otherwise removes `select_tools` and strips the `deferred` metadata; `legalize-tools` deduplicates declarations with top-level priority and keeps the same cleanup as a boundary safeguard. `toolsHash` and the persisted tool snapshot cover every resolved tool, including deferred ones. The `tool_select` experimental flag and `KIMI_CODE_EXPERIMENTAL_TOOL_SELECT` are removed: on-demand tool loading is enabled solely by the model's `dynamically_loaded_tools` and `tool_use` capabilities, and the desktop no longer forces the environment variable.

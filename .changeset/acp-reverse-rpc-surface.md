---
'@moonshot-ai/kimi-code': minor
---

Extend the native ACP server's client-facing surface. `initialize` now records the client's declared capabilities (`fs.readTextFile` / `fs.writeTextFile` / `terminal`) and advertises `promptCapabilities.image: true`, since the engine handles native media injection. `session/prompt` projects ACP `image` content blocks into native media blocks and runs the turn through `run_turn_with_media`, so image prompts reach the model instead of being flattened to text. `AcpChannel` gains the agent→client reverse-RPC wrappers the ACP spec defines — `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` — which a host can use when the matching client capability is present.

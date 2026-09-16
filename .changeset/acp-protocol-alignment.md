---
'@moonshot-ai/kimi-code': patch
---

Align the ACP host with the protocol: `session/prompt` now answers with a real ACP `stopReason` (`end_turn` / `cancelled` / `refusal` / `max_tokens` / `max_turn_requests`) instead of the engine's Rust enum name, so a cancelled turn shows as cancelled and strict clients can parse the response. `$/cancel_request` is handled (it aborts the named prompt's turn), `session/set_model` and the `model` arm of `session/set_config_option` switch the session's model, and `additionalDirectories` on `session/new` extends the session's authorized roots. The reverse Bash path now runs in the session's working directory with the engine's shell and environment, caps terminal output at 4 MiB, and kills a command that outlives its timeout through `terminal/kill`.

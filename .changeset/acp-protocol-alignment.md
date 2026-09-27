---
'@moonshot-ai/kimi-code': patch
---

Align the ACP host with the protocol: `session/prompt` answers with a real ACP `stopReason` so a cancelled turn reads as cancelled, `$/cancel_request` aborts the named prompt, `session/set_model` and the `model` arm of `session/set_config_option` switch the session's model, and `session/new` accepts `additionalDirectories`. The reverse Bash path now runs in the session's working directory and caps terminal output at 4 MiB.

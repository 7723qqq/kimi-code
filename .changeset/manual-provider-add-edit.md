---
"@moonshot-ai/kimi-code": minor
---

Add hand-filled provider setup: `/provider` → add → manual entry types in the provider ID, protocol, API key, base URL and model rows, and `E` on a provider row edits it, renaming included. The same two operations are available from the shell as `kimi provider create` and `kimi provider update`.

Remove the `kimi-web` app from this repository: its Vue source no longer lives here, while the `kimi web` command and the prebuilt bundle it serves are unchanged.

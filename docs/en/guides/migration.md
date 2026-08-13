# Migrating from kimi-cli

The one-time migration flow from the legacy kimi-cli installation is no longer part of Kimi Code CLI — it was removed together with the old TypeScript distribution, and the current Rust-based CLI does not bundle a migration screen.

::: info
`kimi migrate` and the automatic first-run migration prompt no longer exist: the Rust CLI only prints a notice for `kimi migrate` and exits.
:::

The current CLI reads its configuration and sessions from `~/.kimi-code/` and never modifies or deletes data under `~/.kimi/` from an older installation.

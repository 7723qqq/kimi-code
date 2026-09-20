# Migrating from kimi-cli

::: warning Migration is no longer available
The interactive `kimi migrate` command and its automatic first-run prompt have been removed. The legacy `~/.kimi/` data under the old Python/uv installation is left untouched — nothing reads or deletes it — but Kimi Code CLI no longer imports config, MCP servers, or session history from it automatically.
:::

Kimi Code CLI went through a major version upgrade — rewritten from Python/uv into TypeScript, and the current release runs on Bun — bringing a simpler install experience, faster startup, and a redesigned terminal UI.

## What's new

- **No more Python / uv**: Rewritten in TypeScript — no Python environment needed, simpler to install
- **Native binary, works out of the box**: Faster startup, lighter footprint
- **Redesigned terminal UI**: Smoother, more responsive experience

## Moving your configuration over

Because there is no importer, carry the settings you care about across by hand. The two config files do not share a format, so this is a manual read-and-rewrite rather than a copy.

**Configuration.** Open the legacy `~/.kimi/config.toml` (or its `.json` predecessor) and re-enter what you still need in the new `~/.kimi-code/config.toml`. Providers, model aliases, and MCP servers are the usual candidates; see [Configuration files](../configuration/config-files.md) for the current schema and [Providers](../configuration/providers.md) for the provider block shape.

**MCP servers.** Copy each server's `command`, `args`, and `env` (or `url`) into the new `[mcp_servers]` table. After starting Kimi Code, `/mcp` lists what loaded and reports connection failures.

**Skills.** Legacy skills are directories of Markdown files. Copy them into one of the directories documented under [Agent Skills](../customization/skills.md) — a project-local `.agents/skills/` or the user-level `$KIMI_CODE_HOME/skills/`.

**Credentials are not transferable.** OAuth login state under the old home is not read by the new CLI, so run `/login` once after switching. MCP servers that use their own authorization need re-authorizing as well.

## Session history

Legacy sessions cannot be imported. They remain readable as plain files under `~/.kimi/`, and the old CLI keeps working exactly as before — the two installations do not interfere with each other. New sessions start fresh in `~/.kimi-code/`.

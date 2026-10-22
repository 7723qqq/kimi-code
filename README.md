# Kimi Code CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/) <br>
[Documentation](https://moonshotai.github.io/kimi-code/en/) · [Issues](https://github.com/7723qqq/kimi-code/issues) · [中文](README.zh-CN.md)

> ⚠️ **This is a personal experimental fork** of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Not affiliated with Moonshot AI. Use at your own risk — do not submit PRs from this fork to upstream.

![Demo of using Kimi Code](./docs/media/intro.gif)

## What's Different in This Fork

Compared to upstream, this fork adds:

- **🌐 i18n / Multi-language support.** Complete Chinese-English bilingual support across TUI, CLI, and Web UI. All hardcoded English strings replaced with `t()` calls. Switch locale via the `/settings` dialog (aliased as `/config`), locale selector inside.
- **🤖 Team.** Multi-agent discussion and collaboration tool — agents can debate, cross-review, and reach consensus before output.
- **🪟 Windows launchers.** `start-native.bat` launches the native CLI; `start-desktop.bat` builds/launches a locally vendored desktop shell when present.
- **🥖 Bun as the sole packaging engine.** Release binaries are single-file builds via `bun build --compile`, produced by the CI six-platform matrix (linux/darwin/win32 × x64/arm64). The former default Node.js SEA pipeline has been retired: pi-tui helpers load from the packaged-asset cache, URL-fetch SSRF semantics are identical across runtimes (bundled undici), self-update is engine-aware and still recognizes legacy SEA installs, and `/status` shows a Runtime row.
- Various other fixes and QoL improvements.

For a deeper, contributor-facing breakdown of these additions and how they integrate with the rest of the project, see `DEVELOP.md` → "Fork-specific additions vs upstream".

## What is Kimi Code CLI

Kimi Code CLI is an AI coding agent that runs in your terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI’s Kimi models and can also be configured to use other compatible providers.

## Install

> ⚠️ **This fork does not publish packages or installers.** The official script and npm packages below install **upstream MoonshotAI/kimi-code**, not this fork — they will not give you the i18n or Team features described above. To run this fork, build it from source (see below). The commands are kept here only to document what upstream's install path looks like.

<details>
<summary>Upstream install path (installs upstream, <em>not</em> this fork)</summary>

- **macOS or Linux**:

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Windows (PowerShell)**:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

</details>

> On Windows, the CLI has built-in shell detection: it prefers PowerShell 7, then Windows PowerShell, then Git Bash (if installed). To pin a specific shell (for example `bash.exe`, `pwsh.exe`, or `cmd.exe`), set `KIMI_SHELL_PATH` to its absolute path.

## Run This Fork From Source

Requirements: **Bun >= 1.4** and **Git**. Node.js is not required — Bun is the package manager, runtime, and packaging engine here. The Nix build path (`flake.nix`) is the only thing that still needs Node.js >= 24.15.0.

```sh
git clone https://github.com/7723qqq/kimi-code.git
cd kimi-code
git switch norust          # norust is the working branch; origin/HEAD points at it
bun install
```

Then run the CLI:

```sh
bun run dev:local           # build a bundle (~2s) and run the CLI from it
bun run dev:local:watch     # same, rebuilding and re-running on every change
```

On Windows you can also double-click `start-native.bat`, which launches the CLI.

> ⚠️ **Avoid `dev:cli-only`.** That script executes `src/main.ts` directly, and Bun 1.4.2 does not resolve the `package.json` `imports` wildcard `"#/*": "./src/*.ts"`, so the first `#/` import aborts with `Cannot find module '#/kimi-harness'`. Node resolves those wildcards correctly, but `main.ts` hard-exits on a non-Bun runtime — so neither runtime can run the source path directly. Use `dev:cli` (delegates to `scripts/dev.mjs`) or `dev:local` (bundles first, so tsdown inlines every `#/` specifier).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
bun run dev:local -- --cwd .
```

On first launch, run `/login` inside Kimi Code CLI and choose either Kimi Code OAuth or a Moonshot AI Open Platform API key. After login, try your first task:

```
Take a look at this project and explain its main directories.
```

## Key Features

- **Single-binary distribution.** Upstream offers a one-command install with no Node.js setup, PATH gymnastics, or global module conflicts. (This fork does not publish binaries — build from source.)
- **Blazing-fast startup.** The TUI is ready in milliseconds, so starting a session never feels heavy.
- **Purpose-built TUI.** A carefully tuned interface, optimized end to end for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat and let the agent watch what is hard to describe in words — turn a reference clip into a LUT, a long video into a short, a screen recording into working code, and more.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally with `/mcp-config`, without hand-editing JSON.
- **Rich plugin ecosystem.** Install skills, MCP servers, and data sources from the marketplace or any GitHub repo, with each install's trust level surfaced up front.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated contexts while keeping the main conversation clean.
- **Lifecycle hooks.** Run local commands at key points to gate risky tool calls, audit decisions, trigger desktop notifications, or connect to your own automation.
- **Editor & IDE integration (ACP).** Drive a Kimi Code CLI session straight from Zed, JetBrains, or any [Agent Client Protocol](https://agentclientprotocol.com/) client with `kimi acp`.

## Use it in your editor (ACP)

Kimi Code CLI speaks the [Agent Client Protocol](https://agentclientprotocol.com/), so ACP-compatible editors and IDEs (Zed, JetBrains, …) can drive a session over stdio. Log in once, then point your editor at the `kimi acp` subcommand — no extra login needed.

> Running from source? There is no globally installed `kimi` binary, so point your editor at the bundle this fork produces. Build it once with `bun run dev:local` (or `bun run build`), then reference `apps/kimi-code/dist/main.mjs` in place of the `kimi` command below.

For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then open a new conversation in Zed's Agent panel. See [Using in IDEs](https://moonshotai.github.io/kimi-code/en/guides/ides) for JetBrains setup and troubleshooting, and the [`kimi acp` reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) for the full capability matrix.

## Docs

- [Getting Started](https://moonshotai.github.io/kimi-code/en/guides/getting-started)
- [Interaction and approvals](https://moonshotai.github.io/kimi-code/en/guides/interaction)
- [Sessions](https://moonshotai.github.io/kimi-code/en/guides/sessions)
- [Using in IDEs (ACP)](https://moonshotai.github.io/kimi-code/en/guides/ides)
- [Configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files)
- [Command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)

## Develop

```sh
bun install
```

```sh
bun run dev:local     # run the CLI from a fresh bundle (use this, not dev:cli)
bun run dev:local:watch
bun run build         # build all workspace packages
bun run typecheck     # TypeScript check (builds packages first)
bun run lint          # oxlint --type-aware
bun run test          # run tests (use `bun run test` to run them under Bun)
```

See [DEVELOP.md](DEVELOP.md) for the full command reference and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide.

## Community

- [Issues](https://github.com/7723qqq/kimi-code/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Our TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui). We thank the authors of `pi-tui` for their valuable work.

## License

Released under the [MIT License](LICENSE).

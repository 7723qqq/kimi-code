# Sessions and context

Kimi Code CLI persists every conversation as a "session" — storing message history and metadata so you can close the terminal and pick up right where you left off. This page covers how to resume sessions, manage context, and export or fork sessions.

## Session storage

All sessions are saved under `$KIMI_CODE_HOME/sessions/` (default: `~/.kimi-code/sessions/`), one directory per session:

```text
~/.kimi-code/
├── config.toml
├── logs/
│   └── kimi-code.log       # global diagnostic log
├── sessions/
│   └── <sessionId>/
│       ├── session-meta.json
│       ├── history.jsonl
│       └── logs/
│           └── kimi-code.log
├── agent/
│   └── sessions.db         # app-scope engine store: plugin registry and subagent resume state (SQLite)
└── engine-state/           # under the OS user's ~/.kimi-code; does not move with KIMI_CODE_HOME
    └── <workspace-key>/
        └── state/
```

- `session-meta.json`: session metadata such as title, `lastPrompt`, and `forkedFrom`.
- `history.jsonl`: the message history the SDK persists for session resumption.
- `logs/kimi-code.log`: this session's diagnostic log; only present when a diagnostic event occurs.
- `agent/sessions.db`: the app-scope engine store (SQLite) — the plugin registry and subagent resume state; sessions and conversation history land here only when serving through `kimi web` or `kimi-agent --serve`.
- `engine-state/<workspace-key>/state/`: engine-local state (todos, plan, goals, scheduled tasks, background tasks), bucketed by a digest of the workspace path; under the OS user's home, it does not move with `KIMI_CODE_HOME`.

See [data locations](../configuration/data-locations.md) for the complete layout.

::: warning
Do not manually edit files inside the `sessions/` directory — doing so may prevent sessions from being restored correctly.
:::

## Starting and resuming sessions

Every time you run `kimi` directly it creates a new session. To resume a previous session, use one of the following:

**Resume the most recent session in the current directory:**

```sh
kimi --continue
```

**Resume a specific session by ID:**

```sh
kimi --session abc123
```

**Interactively browse session history and choose one:**

```sh
kimi --session
```

::: warning
`--continue` and `--session` are mutually exclusive.
:::

## Switching sessions inside the TUI

You can manage sessions without leaving the terminal. The following slash commands are available only when the agent is idle:

- **`/new`** (alias `/clear`): switch to a new session, discarding the current context.
- **`/sessions`** (alias `/resume`): browse and resume a previous session.
- **`/fork`**: fork the current session (see below).
- **`/title <text>`** (alias `/rename`): set a session title for easier identification; without arguments, displays the current title.

## Context compression

As a conversation grows, Kimi Code CLI automatically compresses the message history when the context approaches the window limit, freeing up token space. You can also trigger compression manually at any time:

```
/compact
```

You can pass a hint to tell the model what to prioritize when compressing:

```
/compact Keep the discussion about database migrations
```

## Forking a session

To explore a new direction without disrupting the current conversation, use `/fork`:

```
/fork
```

Forking does not switch you away: you stay in the original session and the conversation continues untouched. The fork is an independent copy you can switch to at any time using `/sessions`. A saved `/goal` is not copied to the fork. Start a new goal there if you want autonomous goal work.

After forking, the CLI prints a ready-to-run `kimi --resume` command (also copied to the clipboard) so you can enter the fork directly from a new terminal process.

## Exporting a session

Use `kimi export` to package a session as a ZIP file — useful for sharing, archiving, or filing a bug report:

```sh
kimi export <sessionId>
```

Omitting `sessionId` exports the most recent session in the current directory (with an interactive confirmation prompt; add `-y` to skip). Use `-o` to specify an output path:

```sh
kimi export <sessionId> -o ~/Desktop/my-session.zip
```

The export includes all files in the session directory, including diagnostic logs. The global diagnostic log (`~/.kimi-code/logs/kimi-code.log`) is also bundled by default; add `--no-include-global-log` to exclude it.

You can also export from inside the TUI without leaving the interactive session:

- **`/export-debug-zip`**: produces the same debug ZIP as `kimi export`.
- **`/export-md`** (alias `/export`): exports the conversation as a human-readable Markdown file, suitable for sharing or archiving. Accepts an optional path argument; without one, it writes to `kimi-export-<short-id>-<timestamp>.md` in the current working directory.

In the web UI, `/export` downloads the current session as a diagnostic ZIP. It includes the persisted session data, diagnostic logs, and a bounded metadata-only `logs/kimi-web.jsonl` record of key browser events. Prompt text, WebSocket payloads, and console arguments are not copied into this browser log. This web command differs from the TUI `/export` alias above.

::: tip
Exported files may contain code, command output, and file paths that are sensitive. Review the content before sharing.
:::

## Next steps

- [Data locations](../configuration/data-locations.md) — full directory layout for session files
- [kimi command reference](../reference/kimi-command.md) — complete parameter reference for `--continue`, `--session`, `export`, and other commands

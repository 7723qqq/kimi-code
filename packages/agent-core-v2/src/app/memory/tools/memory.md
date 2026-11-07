Search and manage persistent memory across sessions.

Memory files are markdown documents stored under `~/.kimi-code/memory/`, organized by scope:
- **global** — cross-project knowledge (architecture decisions, coding standards, tool configs)
- **project** — project-specific knowledge tied to the current working directory
- **session** — session-specific notes and context

## Actions

### `search`
Full-text search over all memory entries. Returns matching snippets with scope and relevance score. Requires `query`.
```
Memory({ action: "search", query: "authentication pattern" })
```

### `read`
Read a specific memory file by its relative path.
```
Memory({ action: "read", path: "global/auth-pattern.md" })
```

### `write`
Create or update a memory file. The `scope` determines where it lives:
- `global` — stored at `~/.kimi-code/memory/global/`
- `project` — stored at `~/.kimi-code/memory/projects/<projectId>/`
- `session` — stored at `~/.kimi-code/memory/sessions/<sessionId>/`

```
Memory({
  action: "write",
  scope: "project",
  path: "auth-pattern",
  content: "# Authentication Pattern\n\nUse JWT with refresh tokens..."
})
```

### `list`
List all memory files, optionally filtered by scope.
```
Memory({ action: "list", scope: "global" })
```

### `delete`
Delete a memory file by its relative path.
```
Memory({ action: "delete", path: "global/old-note.md" })
```

### `log`
List the memory repository's recent commits, newest first, each with its short
sha, date and message. Use it to pick a revision before `revert`.
```
Memory({ action: "log" })
```

### `revert`
Roll one memory commit back. Takes the full `sha` reported by `log`; a short sha
is rejected. The search index is resynchronised from disk before the call
returns, so a reverted file stops matching immediately.
```
Memory({ action: "revert", sha: "<full sha>" })
```

## Scope semantics

- `search` covers **every** project and session unless `scope` is given; pass
  `scope` to restrict it to the current project, the global scope, or this
  session.
- `write` defaults to `project` and never writes outside the scope you name.
- `list` defaults to everything; with `scope` it returns only that scope of the
  current project or session.

`project` scope is keyed by the repository when there is one: the identity comes
from the `origin` remote first, then from the repository root, and only falls
back to the working directory path outside git. A repository with an `origin`
remote keeps the same project bucket after re-cloning, renaming or moving; a
repository without one keeps it when you work from any directory inside it.

## Git memory interaction

When the `git_memory` experiment is enabled, `write` additionally requires the
content to cite a real commit: a 7–40 character hex string that `git cat-file`
resolves in the session working directory or in the memory repository. A write
without one is rejected. With the experiment off, no such requirement applies.

## When to use

- **Before starting a task** — search memory for relevant context from past sessions
- **After learning something important** — write it to memory for future reference
- **When you encounter a pattern or decision** — persist it so future you doesn't rediscover it
- **When debugging** — search for similar past issues and their resolutions

Memory persists across sessions and projects. Use it to build up institutional knowledge.

The search index is rebuilt from the files on disk at most once every ten minutes, so
a file edited outside this tool shows up in `search` and `list` within that window
rather than immediately.

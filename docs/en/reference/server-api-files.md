# File endpoints

This page lists the endpoints that read and write files in the session directory, the workspace, and the local machine, and the HTTP behavior of the binary and streaming endpoints. Shared conventions are in [Server API](./server-api.md).

## File system

In-session file operations go through `POST /api/v1/sessions/{session_id}/fs:{action}` with JSON bodies; actions are `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `git_status:batch` / `pull_request` / `pull_request:batch` / `diff` / `open` / `open-in` / `reveal`. Every action body also accepts an optional `runtime_id` (string, default `local`) selecting the runtime that executes the operation; `open`, `open-in`, and `reveal` only work on the `local` runtime. In addition:

| Method and path | Description |
| --- | --- |
| `POST /api/v1/workspace/fs:search` | Session-less workspace search (the body carries the workspace reference) |
| `POST /api/v1/workspace/fs:suggest` | Session-less file-completion candidates (for `@` file mentions) |
| `POST /api/v1/fs:suggest` | File-completion candidates across absolute root directories, without a session or workspace |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | Download a session file (binary, see below) |
| `GET /api/v1/fs:browse` | List host directories (folder picker) |
| `GET /api/v1/fs:home` | The user's home directory and recent workspaces |
| `GET /api/v1/fs:content` | Raw bytes of any host file (gated only by the token — be careful when exposing the port) |
| `POST /api/v1/fs:mkdir` | Create a directory by absolute path |

### `POST /api/v1/sessions/{session_id}/fs:list`

Lists the entries of a session workspace directory, optionally recursing into subdirectories.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | Directory to list, relative to the session work directory. Default `.` |
| `depth` | body | integer | Recursion depth, 1–10. Default `1` |
| `limit` | body | integer | Maximum entries, 1–1000. Default `200` |
| `show_hidden` | body | boolean | Include dotfiles. Default `false` |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `exclude_globs` | body | string[] | Additional globs to skip |
| `allow_ignored_globs` | body | string[] | Globs to show even when gitignored (e.g. `.tmp`). Ignored ancestor directories of a match are kept so the match stays reachable. Allowing dot-paths also requires `show_hidden: true` |
| `sort` | body | string | `type_first` (default) / `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | Attach each entry's git status. Default `false` |

On success, `data` is `{ items, truncated }` — plus `children_by_path` (a path → entries map) when `depth` is greater than 1. Each item is an entry object `{ path, name, kind, size?, modified_at, etag?, mime?, language_id?, is_binary?, is_directory?, is_symlink_to?, git_status?, child_count? }`, where `kind` is `file` / `directory` / `symlink`, `is_directory` marks a symlink whose target is a directory, and `git_status` (present only with `include_git_status: true`) is one of `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted`; `truncated` reports that `limit` or the recursive symlink budget cut the listing short. Entries reached by expanding symlinked directories are capped at 10,000 per request; ordinary directory recursion is not capped.

- `40001`: body validation failure
- `40401`: session not found
- `40409`: path not found (including a `path` that is not a directory)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:read`

Reads a slice of a session file as text or base64.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | **Required.** File path, relative to the session work directory |
| `offset` | body | integer | Byte offset to start at. Default `0` |
| `length` | body | integer | Bytes to read, 1–10485760 (10 MiB). Default `1048576` (1 MiB) |
| `encoding` | body | string | `auto` (default) / `utf-8` / `base64` |

On success, `data` is `{ path, content, encoding, size, truncated, etag, mime, language_id?, line_count?, is_binary }`, where `encoding` reports the encoding actually used (`utf-8` or `base64`) and `size` is the full file size. With `encoding: "auto"`, text comes back as `utf-8` (non-UTF-8 text is transcoded) and binary content as `base64`; `encoding: "utf-8"` forces text and rejects binary files.

- `40001`: body validation failure
- `40401`: session not found
- `40409`: path not found
- `40906`: path is a directory
- `40907`: binary file requested with `encoding: "utf-8"`
- `41302`: file exceeds the 10 MiB read ceiling
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:list_many`

Lists several session directories in one call; a failing path folds into the response instead of failing the whole request.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `paths` | body | string[] | **Required.** Directories to list, 1–100 entries |

The remaining body fields (`depth`, `limit`, `show_hidden`, `follow_gitignore`, `exclude_globs`, `sort`, `include_git_status`) have the same types, ranges, and defaults as `fs:list`. On success, `data` is `{ results }`, a map from each requested path to its entry array (entry objects as described under `fs:list`), plus `truncated_paths` (paths whose listing hit `limit`) and `partial_errors`, a map from a failed path to its `{ code, msg }` error.

- `40001`: body validation failure
- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/fs:stat`

Stats one path in the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | **Required.** Path to stat, relative to the session work directory |

On success, `data` is the entry object described under `fs:list`.

- `40001`: body validation failure
- `40401`: session not found
- `40409`: path not found
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:stat_many`

Stats many session paths in one call; missing paths report `null` instead of failing the request.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `paths` | body | string[] | **Required.** Paths to stat, 1–1000 entries |

On success, `data` is `{ entries }`, a map from each requested path to its entry object (as described under `fs:list`) or `null` when the path does not exist.

- `40001`: body validation failure
- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/fs:mkdir`

Creates a directory inside the session workspace.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | **Required.** Directory to create, relative to the session work directory |
| `recursive` | body | boolean | Create missing parent directories. Default `false` |

On success, `data` is the created directory's entry object (as described under `fs:list`).

- `40001`: body validation failure
- `40401`: session not found
- `40409`: parent directory not found (non-recursive create)
- `40919`: path already exists (non-recursive create)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:search`

Fuzzy-searches file and directory names across the session workspace. An empty `query` lists the top-level entries instead. When the `{session_id}` slot carries a workspace reference (a registered workspace id or an absolute root) rather than a session id, the search runs against that workspace — the session-less form for a not-yet-created draft session; the first-class session-less endpoint is `POST /api/v1/workspace/fs:search`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id, or a workspace reference |
| `query` | body | string | **Required.** Search text; `""` lists the top level |
| `limit` | body | integer | Maximum hits, 1–200. Default `50` |
| `include_globs` | body | string[] | Only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |

On success, `data` is `{ items, truncated }` where each item is `{ path, name, kind, score, match_positions }` — `kind` is `file` / `directory` / `symlink`, `score` is the fuzzy-match score between 0 and 1, and `match_positions` lists the matched character offsets. Hits prioritize match quality and place ignored hits after non-ignored hits of equal quality. Including ignored hits may require a supplemental scan; `truncated` reports that hits beyond `limit` were dropped.

- `40001`: body validation failure
- `40401`: neither a session nor a resolvable workspace with that reference

### `POST /api/v1/sessions/{session_id}/fs:grep`

Searches file contents across the session workspace — a literal string by default, a regular expression with `regex: true`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `pattern` | body | string | **Required.** Text or regex to search for |
| `regex` | body | boolean | Treat `pattern` as a regular expression. Default `false` |
| `case_sensitive` | body | boolean | Default `true` |
| `include_globs` | body | string[] | Only files matching one of these globs |
| `exclude_globs` | body | string[] | Skip files matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths. Default `true` |
| `max_files` | body | integer | Files to scan at most, 1–10000. Default `200` |
| `max_matches_per_file` | body | integer | Matches kept per file, 1–10000. Default `50` |
| `max_total_matches` | body | integer | Matches kept overall, 1–100000. Default `5000` |
| `context_lines` | body | integer | Context lines around each match, 0–10. Default `2` |

On success, `data` is `{ files, files_scanned, truncated, elapsed_ms }` where each entry of `files` is `{ path, matches }` and each match is `{ line, col, text, before, after }` (`before` / `after` carry up to `context_lines` surrounding lines); `truncated` reports that one of the match budgets cut the results short.

- `40001`: body validation failure
- `40401`: session not found
- `41305`: the search timed out

### `POST /api/v1/sessions/{session_id}/fs:git_status`

Reads git status, optionally restricted to a set of paths. When `root` is provided, entry paths are relative to that directory; when omitted, status covers the whole Git worktree and entry paths are relative to the repository root.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `root` | body | string | Workspace directory to scope to. When omitted, status covers the whole Git worktree; a relative value is resolved from the session work directory |
| `paths` | body | string[] | Restrict the status to these paths. Relative paths are resolved from `root` when provided, otherwise from the session work directory |
| `include_pull_request` | body | boolean | Include the associated pull request. Default `true` |

On success, `data` is `{ branch, ahead, behind, entries, additions, deletions, pullRequest }` where `entries` maps each changed path to its status (`clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted`) and `pullRequest` is `{ number, state, url }` (`state` is `open` / `merged` / `closed` / `draft`) or `null`.

- `40001`: body validation failure
- `40401`: session not found
- `40908`: git is unavailable (not a repository, or no git binary)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:git_status:batch`

Reads git status for several workspace directories in one call. A failing directory folds into `errors` instead of failing the whole request.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `roots` | body | string[] | **Required.** Workspace directories to inspect, 1–32 entries |
| `include_pull_request` | body | boolean | Include the associated pull request in each result. Default `true` |

On success, `data` is `{ results, errors }`. `results` maps each successful root to the same status object as `fs:git_status`; `errors` maps each failed root to its `{ code, msg }` error, using the same error codes as the single-directory action.

- `40001`: body validation failure
- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/fs:pull_request`

Reads the pull request associated with a session workspace directory.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `root` | body | string | Workspace directory to inspect. Defaults to the session work directory; a relative value is resolved from it |

On success, `data` is `{ number, state, url }` (`state` is `open` / `merged` / `closed` / `draft`) or `null` when no pull request is found.

- `40001`: body validation failure
- `40401`: session not found
- `40908`: git is unavailable (not a repository, or no git binary)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:pull_request:batch`

Reads pull requests for several workspace directories in one call. A failing directory folds into `errors` instead of failing the whole request.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `roots` | body | string[] | **Required.** Workspace directories to inspect, 1–32 entries |

On success, `data` is `{ results, errors }`. `results` maps each successful root to the same pull request object as `fs:pull_request`, or `null`; `errors` maps each failed root to its `{ code, msg }` error.

- `40001`: body validation failure
- `40401`: session not found

### `POST /api/v1/sessions/{session_id}/fs:diff`

Returns the unified git diff of one file in a session workspace directory.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | **Required.** File to diff, relative to `root` |
| `root` | body | string | Workspace directory to inspect. Defaults to the session work directory; a relative value is resolved from it |

On success, `data` is `{ path, diff, truncated }` where `diff` is the unified diff text and `truncated` reports an over-long diff cut short.

- `40001`: body validation failure
- `40401`: session not found
- `40908`: git is unavailable (not a repository, or no git binary)
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:open`

Opens a session file with the host operating system's default handler. Local runtime only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | **Required.** File to open, relative to the session work directory |
| `line` | body | integer | Line number to jump to where the handler supports it (positive integer) |

On success, `data` is `{ opened: true }`.

- `40001`: body validation failure
- `40401`: session not found
- `40409`: path not found
- `41304`: path escapes the session workspace

### `POST /api/v1/sessions/{session_id}/fs:open-in`

Opens a session file or directory in a specific host application. Local runtime only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `app_id` | body | string | **Required.** Target application: `finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | **Required.** File or directory to open, relative to the session work directory |
| `line` | body | integer | Line number to jump to where the application supports it (positive integer) |

On success, `data` is `{ opened: true }`.

- `40001`: body validation failure
- `40401`: session not found
- `40409`: path not found
- `41304`: path escapes the session workspace
- `50001`: the application failed to launch

### `POST /api/v1/sessions/{session_id}/fs:reveal`

Reveals a session file in the host operating system's file manager. Local runtime only.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | body | string | **Required.** File to reveal, relative to the session work directory |

On success, `data` is `{ revealed: true }`.

- `40001`: body validation failure
- `40401`: session not found
- `40409`: path not found
- `41304`: path escapes the session workspace

### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

Downloads a file from the session workspace; `{path}` is the workspace-relative file path with the literal `:download` suffix. The response is a binary stream with range and ETag support — see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `session_id` | path | string | **Required.** Session id |
| `path` | path | string | **Required.** Workspace-relative file path plus the `:download` suffix |
| `runtime_id` | query | string | Runtime to read from. Default `local` |

- `40001`: missing or empty path
- `40401`: session not found
- `40409`: path not found
- `41304`: path escapes the session workspace

### `POST /api/v1/workspace/fs:search`

The session-less form of `fs:search`: the workspace travels in the body instead of the URL.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | **Required.** Registered workspace id or absolute root (registered on the spot) |
| `query` | body | string | **Required.** Search text; `""` lists the top level |
| `limit` | body | integer | Maximum hits, 1–200. Default `50` |
| `include_globs` | body | string[] | Only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |
| `runtime_id` | body | string | Runtime to search on. Default `local` |

On success, `data` is `{ items, truncated }` with the same hit shape and ordering as `fs:search`.

- `40001`: body validation failure
- `40410`: workspace not found and not a usable absolute path

### `POST /api/v1/workspace/fs:suggest`

Suggests file and directory completion candidates in a workspace without a session — the backend for `@` file mentions in the composer.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace` | body | string | **Required.** Registered workspace id or absolute root (registered on the spot) |
| `query` | body | string | **Required.** Partial path text to complete |
| `limit` | body | integer | Maximum candidates, 1–200. Default `50`; fd-backed searches return at most `20` |
| `follow_gitignore` | body | boolean | Skip gitignored paths when `true`. Default `false` |
| `show_hidden` | body | boolean | Include dotfiles. Default `false`; fd-backed searches always include them |
| `stream` | body | boolean | Return NDJSON preview/final events when `true`. Default `false` |
| `include_globs` | body | string[] | Only paths matching one of these globs |
| `exclude_globs` | body | string[] | Skip paths matching these globs |
| `runtime_id` | body | string | Runtime to complete on. Default `local` |

On success, `data` is `{ items, truncated }` where each item is `{ path, name, kind, score, match_positions }`, the same hit shape as `fs:search`. Candidates prioritize match quality and place ignored candidates after non-ignored candidates of equal quality. When fd is available, searches use the local `@`-completion strategy: hidden paths are always included, each root scans at most 100 entries per pass, and at most 20 items are returned. Matches beyond the scan cap may be omitted. Including ignored candidates may require a supplemental `--no-ignore-vcs` scan; the ripgrep/Node fallback applies when fd is unavailable.

With `stream:true`, the response is NDJSON instead of a single JSON object. Each envelope's `data` includes `phase` (`preview`, `final`, or `error`) and the same result fields. A preview contains ordinary fd candidates with `truncated:true`; the final result replaces it after the ignored scan. Closing the connection cancels the search.

- `40001`: body validation failure
- `40410`: workspace not found and not a usable absolute path

### `POST /api/v1/fs:suggest`

Suggests file and directory completion candidates across one or more absolute root directories, without a session or a workspace; nothing is registered. The first root is the primary root: its candidates come back as relative paths, and candidates under the other roots as absolute paths. Overlapping roots are searched once.

The body takes `roots` in place of `workspace`, plus the same `query`, `limit`, `follow_gitignore`, `show_hidden`, `stream`, `include_globs`, and `exclude_globs` fields as `POST /api/v1/workspace/fs:suggest`. It is local-only: unlike the workspace form it takes no `runtime_id`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `roots` | body | string[] | **Required.** 1–32 absolute directory paths; the first is the primary root |

The response, including the NDJSON form with `stream: true`, is the same as for `POST /api/v1/workspace/fs:suggest`.

- `40001`: body validation failure, including a root that is not an absolute path
- `40409`: a root does not exist or is not a directory (`details.path` names it)

### `GET /api/v1/fs:browse`

Lists the subdirectories of one host directory — the backend of the folder picker.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | query | string | Absolute directory path. Default the user's home directory |

On success, `data` is `{ path, parent, entries }` where `path` is the resolved directory, `parent` its parent (`null` at the filesystem root), and each entry is `{ name, path, is_dir: true }`.

- `40001`: `path` is not absolute
- `40409`: path not found
- `40411`: permission denied

### `GET /api/v1/fs:home`

Returns the folder picker's landing payload. No parameters.

On success, `data` is `{ home, recent_roots }` where `home` is the user's home directory and `recent_roots` lists the roots of the registered workspaces.

### `GET /api/v1/fs:content`

Streams the raw bytes of any file on the host filesystem — gated only by the API token, so be careful when exposing the port. Range requests and ETag caching are supported; see [Binary and streaming endpoints](#binary-and-streaming-endpoints).

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | query | string | **Required.** Absolute file path |

- `40001`: `path` is not absolute, or not a regular file
- `40409`: path not found
- `40411`: permission denied
- `40906`: path is a directory

### `POST /api/v1/fs:mkdir`

Creates one directory on the host filesystem by absolute path — the folder picker's "new folder" backend. Non-recursive: the parent directory must already exist.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `path` | body | string | **Required.** Absolute directory path |

On success, `data` is `{ path }`.

- `40001`: `path` is not absolute
- `40409`: parent path not found
- `40411`: permission denied
- `40919`: path already exists

## Binary and streaming endpoints

The following endpoints stream binary bodies instead of a JSON payload. Their HTTP capabilities differ per endpoint:

| Method and path | Description | Range (206) | ETag / 304 |
| --- | --- | --- | --- |
| `GET /api/v1/files/{file_id}` | Download an uploaded file | Yes | No (sends an `etag` header but ignores `If-None-Match`) |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | Download a session workspace file | Yes | Yes |
| `GET /api/v1/fs:content` | Raw bytes of any host file (gated only by the token — be careful when exposing the port) | Yes | Yes |
| `POST /api/v1/sessions/{session_id}/export` | Export the session with diagnostics (zip stream) | No | No |

Error semantics differ as well: `GET /api/v1/files/{file_id}`, `GET /api/v1/fs:content`, and session `:download` answer failures with real 4xx / 500 statuses and the same [response envelope](#response-envelope). Session export reports errors with an HTTP 200 envelope. Ordinary JSON RPC endpoints keep the almost-always-200 convention, so clients must check the envelope `code` on those endpoints.

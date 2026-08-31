//! Tool definitions for the core native tools (Read / Grep / Glob / Write /
//! Edit / Bash / FetchURL / WebSearch), so the REPL's LLM can discover and
//! call them. Descriptions and input schemas mirror the v2 agent tool
//! definitions (`packages/agent-core-v2/src/agent/tools/...`): descriptions
//! are the rendered `.md` templates (placeholders replaced with the v2
//! constants) and schemas are the v2 `toInputJsonSchema` output of the zod
//! input schemas.

use serde_json::json;

use crate::turn_loop::types::ToolInfo;

const READ_DESCRIPTION: &str = r#"Read a text file from the local filesystem.

If the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use `Grep` only when the task is to search for unknown content or locations.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Relative paths resolve against the working directory; a path outside the working directory must be absolute.
- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line (recover the elided content with Bash, e.g. `cut` or `sed`).
- Page larger files with `line_offset` (1-based start line) and `n_lines`. Omit `n_lines` to read up to the 1000-line cap.
- Sensitive files (`.env` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: `.env.example` / `.env.sample` / `.env.template` and public SSH keys such as `id_rsa.pub` read normally.
- UTF-8 text files are read directly. UTF-16 LE/BE text files (with or without a BOM) are detected automatically and transcoded to UTF-8 for display; the status block notes the detected encoding, and Edit/Write on such a file still expect UTF-8 — convert its encoding first (e.g. with `iconv`). Other encodings (e.g. GBK), binary files, and files containing NUL bytes are refused.
- **Images and videos** (max 100MB) are sent to the model as multimodal media instead of text; this requires a model with the matching vision capability (`image_in` / `video_in`). `region` and `full_resolution` apply only to images; `line_offset` and `n_lines` apply only to text files.
- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the `<system>` block, never by measuring the displayed copy. When the `<system>` tag reports downsampling and you need that detail, call Read again with the `region` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set `full_resolution` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.
- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.
- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed 1000.
- Output format: `<line-number>\t<content>` per line.
- A `<system>...</system>` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.
- Pure CRLF files are displayed with LF line endings; `Edit` matches this output and preserves CRLF when writing back.
- Mixed or lone carriage-return line endings are shown as `\r` and require exact `Edit.old_string` escapes.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.
"#;

const GREP_DESCRIPTION: &str = r#"Search file contents using regular expressions (powered by ripgrep).

Use Grep when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.
ALWAYS use Grep tool instead of running `grep` or `rg` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.
If you already know a concrete file path and need to inspect its contents, use Read directly instead.

Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\{` to match a literal `{`.

Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. To also search files excluded by `.gitignore` (such as `node_modules` or build outputs), set `include_ignored` to `true`. Sensitive files (such as `.env`) are always skipped for safety, even when `include_ignored` is `true`.
"#;

const GLOB_DESCRIPTION: &str = r#"Find files by glob pattern, sorted by modification time (most recent first).

Powered by ripgrep. Respects `.gitignore`, `.ignore`, and `.rgignore` by default — set `include_ignored` to also match ignored files (e.g. build outputs, `node_modules`). Sensitive files (such as `.env`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).

Good patterns:
- `*.ts` — all files matching an extension, at any depth below the search root (a bare pattern without `/` matches recursively)
- `src/*.ts` — files directly inside `src/` (one level, not recursive)
- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension
- `**/*.py` — recursive walk from the search root for an extension
- `*.{ts,tsx}` — brace expansion is supported
- `{src,test}/**/*.ts` — cartesian brace expansion is supported too

Results are capped at the first 100 matching paths. If a search would return more, a truncation marker is appended. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.

Large-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when `include_ignored` is set:
- `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` can produce thousands of results that truncate at the match cap and waste context. Prefer specific subpaths like `node_modules/react/src/**/*.js`.
"#;

const WRITE_DESCRIPTION: &str = r#"Create, append to, or replace a file entirely.

- Missing parent directories are created automatically (like `mkdir(parents=True, exist_ok=True)`).
- Mode defaults to overwrite; append adds content at EOF without adding a newline.
- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.
- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.
- Do not create unsolicited documentation files (`*.md` write-ups, `README`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).
- Read before overwriting an existing file.
- Write ignores the Read/Edit line-number view. NEVER include line prefixes.
- Write outputs content literally, including supplied line endings: \n stays LF, \r\n stays CRLF.
- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.
"#;

const EDIT_DESCRIPTION: &str = r#"Perform exact replacements in existing files.

- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash `sed`.
- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed `old_string`.
- Take `old_string` and `new_string` from the Read output view.
- Drop the line-number prefix and tab; match only file content.
- `old_string` must be unique unless `replace_all` is set.
- If `old_string` is ambiguous, add surrounding context. Use `replace_all` only when every occurrence should change — for example, renaming a symbol throughout the file.
- Multiple Edit calls may run in one response only when they do not target the same file.
- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's `old_string`, causing `old_string not found`. Read the file again before the next Edit.
- A write lock serializes same-file edits in response order, but serialization does not make stale `old_string` valid.
- For pure CRLF files, Read shows LF; use LF in `old_string` and `new_string`, and Edit writes CRLF back.
- For mixed endings or lone carriage returns, Read shows carriage returns as \r; include actual \r escapes in those positions.
"#;

const BASH_DESCRIPTION: &str = r#"Execute a `bash` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.

**Translate these to a dedicated tool instead:**
- `cat` / `head` / `tail` (known path) → `Read`
- `sed` / `awk` (in-place edit) → `Edit`
- `echo > file` / `cat <<EOF` → `Write`
- `find` / recursive `ls` to locate files by name pattern → `Glob` (plain `ls <known-directory>` is fine for listing a directory)
- `grep` / `rg` (search file contents) → `Grep`
- `echo` / `printf` (talk to the user) → just output text directly

The dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.

**Output:**
The stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a `Command failed with exit code: N` line; a command killed by its timeout or interrupted by the user ends with its own message instead.

If `run_in_background=true`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short `description`. Background commands default to a 600s timeout and `timeout` is capped at 86400s; set `disable_timeout=true` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use `TaskOutput` only for a non-blocking status/output snapshot — do not wait on a task you just launched, since its completion arrives automatically. Use `TaskStop` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the background-task panel.

**Guidelines for safety and security:**
- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the `cwd` argument (or use absolute paths) rather than relying on a `cd` from an earlier call.
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the `timeout` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes. The user can also move a running foreground command to the background at any time.
- Avoid using `..` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- Use `&&` to chain commands that genuinely depend on each other, e.g. `npm install && npm test`. Independent read-only commands (separate `git show`, `ls`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with `echo` separators.
- Use `;` to run commands sequentially regardless of success/failure
- Use `||` for conditional execution (run second command only if first fails)
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Compose multi-step logic in a single call with `if` / `case` / `for` / `while` control flows.
- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.

**Commands available:**
The following common command categories are usually available. Availability still depends on the host, so when in doubt run `which <command>` first to confirm a command exists before relying on it.
- Navigation and inspection: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`
- File and directory management: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`
- Text and data processing: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`
- Archives and compression: `tar`, `gzip`, `gunzip`, `zip`, `unzip`
- Networking and transfer: `curl`, `wget`, `ping`, `ssh`, `scp`
- Version control: `git`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the `gh` CLI when installed — it carries the user's GitHub auth and can return structured JSON
- Process and system: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`
- Language and package toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use whichever the project actually relies on)
"#;

const FETCH_URL_DESCRIPTION: &str = r#"Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.

Only fully-formed public `http`/`https` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.
"#;

const WEB_SEARCH_DESCRIPTION: &str = r#"Search the web for information. Use this when you need up-to-date information from the internet.

Each result includes its title, its URL, and a snippet, plus its source site and publication date when available. Results are short summaries, not full pages — when a result looks relevant, call the FetchURL tool on its URL to read the full page content. Fetch only the few URLs you actually need. Prefer specific queries, and refine the query if the results don't contain what you need.

When you rely on a result in your answer, cite its source URL so the user can verify it.
"#;

/// Windows-only suffix appended to the Glob description, mirroring the v2
/// `GlobTool.description` getter (pathClass === 'win32').
const GLOB_WINDOWS_PATH_HINT: &str = r#"

Windows note: the `path` argument accepts both Windows paths (e.g. `C:\Users\foo`) and POSIX-style paths (e.g. `/c/Users/foo`). Matched paths are returned in Windows backslash form; convert them to forward slashes before using them in a Bash command."#;

fn glob_description() -> String {
    if cfg!(windows) {
        format!("{GLOB_DESCRIPTION}{GLOB_WINDOWS_PATH_HINT}")
    } else {
        GLOB_DESCRIPTION.to_string()
    }
}

/// Tool definitions for the core native tools, so the model can discover
/// and call them (used by the standalone REPL).
pub fn core_tool_defs() -> Vec<ToolInfo> {
    vec![
        ToolInfo {
            name: "Read".into(),
            description: READ_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to a file. Text files are read as text; image and video files are sent to the model as multimodal content (requires a model with the matching vision capability). Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search."
                    },
                    "line_offset": {
                        "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.",
                        "anyOf": [
                            {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 9007199254740991i64
                            },
                            {
                                "type": "integer",
                                "minimum": -1000,
                                "maximum": -1
                            }
                        ]
                    },
                    "n_lines": {
                        "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines. Text files only.",
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "region": {
                        "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.",
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 9007199254740991i64,
                                "description": "Left edge of the crop, in original-image pixels."
                            },
                            "y": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 9007199254740991i64,
                                "description": "Top edge of the crop, in original-image pixels."
                            },
                            "width": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 9007199254740991i64,
                                "description": "Crop width, in original-image pixels."
                            },
                            "height": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 9007199254740991i64,
                                "description": "Crop height, in original-image pixels."
                            }
                        },
                        "required": [
                            "x",
                            "y",
                            "width",
                            "height"
                        ],
                        "additionalProperties": false
                    },
                    "full_resolution": {
                        "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.",
                        "type": "boolean"
                    }
                },
                "required": [
                    "path"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "Grep".into(),
            description: GREP_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for."
                    },
                    "path": {
                        "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.",
                        "type": "string"
                    },
                    "glob": {
                        "description": "Optional glob filter for which files to search, e.g. `*.ts`. Matched against each file's full absolute path, so a path-anchored pattern like `src/**/*.ts` silently matches nothing — use a basename pattern (`*.ts`), or anchor with `**/` (`**/src/**/*.ts`). To scope the search to a directory, use `path` instead.",
                        "type": "string"
                    },
                    "type": {
                        "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over `glob` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.",
                        "type": "string"
                    },
                    "output_mode": {
                        "description": "Shape of the result. `content` shows matching lines (honors `-A`, `-B`, `-C`, `-n`, and `head_limit`); `files_with_matches` shows only the paths of files that contain a match, most-recently-modified first (honors `head_limit`); `count_matches` shows per-file match counts as `path:count` lines, preceded by an aggregate total line. Defaults to `files_with_matches`.",
                        "type": "string",
                        "enum": [
                            "content",
                            "files_with_matches",
                            "count_matches"
                        ]
                    },
                    "-i": {
                        "description": "Perform a case-insensitive search. Defaults to false.",
                        "type": "boolean"
                    },
                    "-n": {
                        "description": "Prefix each matching line with its line number. Applies only when `output_mode` is `content`. Defaults to true.",
                        "type": "boolean"
                    },
                    "-A": {
                        "description": "Number of lines to show after each match. Applies only when `output_mode` is `content`.",
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "-B": {
                        "description": "Number of lines to show before each match. Applies only when `output_mode` is `content`.",
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "-C": {
                        "description": "Number of lines to show before and after each match. Applies only when `output_mode` is `content`; takes precedence over `-A` and `-B`.",
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "head_limit": {
                        "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.",
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "offset": {
                        "description": "Number of leading lines/entries to skip before applying `head_limit`. Use it together with `head_limit` to page through large result sets. Defaults to 0.",
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "multiline": {
                        "description": "Enable multiline matching, where the pattern can span line boundaries and `.` also matches newlines. Defaults to false.",
                        "type": "boolean"
                    },
                    "include_ignored": {
                        "description": "Also search files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.",
                        "type": "boolean"
                    }
                },
                "required": [
                    "pattern"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "Glob".into(),
            description: glob_description(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to match files."
                    },
                    "path": {
                        "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.",
                        "type": "string"
                    },
                    "include_ignored": {
                        "description": "Also match files excluded by ignore files such as `.gitignore`, `.ignore`, and `.rgignore` (for example `node_modules` or build outputs). Sensitive files (such as `.env`) remain filtered out for safety. VCS metadata directories (`.git` and similar) are always skipped, even when this is true. Defaults to false.",
                        "type": "boolean"
                    },
                    "include_dirs": {
                        "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.",
                        "type": "boolean"
                    }
                },
                "required": [
                    "pattern"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "Write".into(),
            description: WRITE_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically."
                    },
                    "content": {
                        "type": "string",
                        "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view."
                    },
                    "mode": {
                        "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.",
                        "type": "string",
                        "enum": [
                            "overwrite",
                            "append"
                        ]
                    }
                },
                "required": [
                    "path",
                    "content"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "Edit".into(),
            description: EDIT_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute."
                    },
                    "old_string": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\r escapes where Read shows \\r."
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files."
                    },
                    "replace_all": {
                        "description": "Set true only when every occurrence of old_string should be replaced.",
                        "type": "boolean"
                    }
                },
                "required": [
                    "path",
                    "old_string",
                    "new_string"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "Bash".into(),
            description: BASH_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The command to execute."
                    },
                    "cwd": {
                        "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.",
                        "type": "string"
                    },
                    "timeout": {
                        "default": 60,
                        "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.",
                        "type": "integer",
                        "exclusiveMinimum": 0,
                        "maximum": 9007199254740991i64
                    },
                    "description": {
                        "description": "A short description for the background task. Required when run_in_background is true.",
                        "type": "string"
                    },
                    "run_in_background": {
                        "description": "Whether to run the command as a background task.",
                        "type": "boolean"
                    },
                    "disable_timeout": {
                        "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.",
                        "type": "boolean"
                    }
                },
                "required": [
                    "command"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "FetchURL".into(),
            description: FETCH_URL_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch content from."
                    }
                },
                "required": [
                    "url"
                ],
                "additionalProperties": false
            }),
        },
        ToolInfo {
            name: "WebSearch".into(),
            description: WEB_SEARCH_DESCRIPTION.into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The query text to search for."
                    }
                },
                "required": [
                    "query"
                ],
                "additionalProperties": false
            }),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs_by_name() -> Vec<(String, ToolInfo)> {
        core_tool_defs()
            .into_iter()
            .map(|d| (d.name.clone(), d))
            .collect()
    }

    #[test]
    fn test_core_tool_defs_expose_all_eight_tools() {
        let defs = core_tool_defs();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Read",
                "Grep",
                "Glob",
                "Write",
                "Edit",
                "Bash",
                "FetchURL",
                "WebSearch"
            ]
        );
    }

    #[test]
    fn test_descriptions_render_v2_placeholder_values() {
        let defs = defs_by_name();
        let get = |name: &str| {
            defs.iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("missing def: {name}"))
                .1
                .description
                .clone()
        };

        // Read: ${MAX_LINES} / ${MAX_BYTES_KB} / ${MAX_LINE_LENGTH} /
        // ${MAX_MEDIA_MEGABYTES} rendered with the v2 constants.
        let read = get("Read");
        assert!(read.contains("1000 lines or 100 KB per call"));
        assert!(read.contains("2000 chars are truncated mid-line"));
        assert!(read.contains("1000-line cap"));
        assert!(read.contains("(max 100MB)"));
        assert!(read.contains("the absolute value cannot exceed 1000."));

        // Bash: ${SHELL_NAME} / ${DEFAULT_TIMEOUT_S} / ${MAX_TIMEOUT_S} /
        // ${DEFAULT_BACKGROUND_TIMEOUT_S} / ${MAX_BACKGROUND_TIMEOUT_S}.
        let bash = get("Bash");
        assert!(bash.contains("Execute a `bash` command"));
        assert!(bash.contains("Foreground commands default to 60s and allow up to 300s"));
        assert!(bash.contains("Background commands default to a 600s timeout"));
        assert!(bash.contains("`timeout` is capped at 86400s"));

        // Glob: the v2 template mentions the 100-match cap.
        assert!(get("Glob").contains("first 100 matching paths"));

        for (name, def) in &defs {
            assert!(!def.description.is_empty(), "empty description for {name}");
        }
    }

    #[test]
    fn test_input_schemas_have_object_shape_and_required_fields() {
        let defs = defs_by_name();
        for (name, def) in &defs {
            assert_eq!(def.input_schema["type"], "object", "type for {name}");
            assert!(
                def.input_schema["properties"].is_object(),
                "properties for {name}"
            );
            assert_eq!(
                def.input_schema["additionalProperties"], false,
                "additionalProperties for {name}"
            );
        }

        let required = |name: &str| {
            defs.iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("missing def: {name}"))
                .1
                .input_schema["required"]
                .clone()
        };
        assert_eq!(required("Read"), json!(["path"]));
        assert_eq!(required("Grep"), json!(["pattern"]));
        assert_eq!(required("Glob"), json!(["pattern"]));
        assert_eq!(required("Write"), json!(["path", "content"]));
        assert_eq!(
            required("Edit"),
            json!(["path", "old_string", "new_string"])
        );
        assert_eq!(required("Bash"), json!(["command"]));
        assert_eq!(required("FetchURL"), json!(["url"]));
        assert_eq!(required("WebSearch"), json!(["query"]));
    }

    #[test]
    fn test_field_descriptions_match_v2_zod_describe_text() {
        let defs = defs_by_name();
        let get = |name: &str| {
            defs.iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("missing def: {name}"))
                .1
                .input_schema
                .clone()
        };

        // Read.path — verbatim v2 zod .describe() text.
        assert_eq!(
            get("Read")["properties"]["path"]["description"],
            "Path to a file. Text files are read as text; image and video files are sent to the model as multimodal content (requires a model with the matching vision capability). Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use `ls` via Bash for a known directory, or Glob for pattern search."
        );

        // Grep.pattern — verbatim v2 zod .describe() text.
        assert_eq!(
            get("Grep")["properties"]["pattern"]["description"],
            "Regular expression to search for."
        );

        // Bash.timeout — the v2 .describe() text with rendered constants.
        assert_eq!(
            get("Bash")["properties"]["timeout"]["description"],
            "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true."
        );

        // Read.line_offset — z.union maps to anyOf with the v2 bounds.
        let read_schema = get("Read");
        let any_of = read_schema["properties"]["line_offset"]["anyOf"]
            .as_array()
            .expect("line_offset anyOf");
        assert_eq!(any_of[0]["type"], "integer");
        assert_eq!(any_of[0]["minimum"], 1);
        assert_eq!(any_of[1]["type"], "integer");
        assert_eq!(any_of[1]["minimum"], -1000);
        assert_eq!(any_of[1]["maximum"], -1);

        // Read.region — nested object with its own required list.
        let region = &read_schema["properties"]["region"];
        assert_eq!(region["type"], "object");
        assert_eq!(region["required"], json!(["x", "y", "width", "height"]));
        assert_eq!(region["additionalProperties"], false);
    }
}

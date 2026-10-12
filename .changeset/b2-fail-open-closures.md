---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/pi-tui": patch
"@moonshot-ai/tree-sitter-bash": patch
"@moonshot-ai/kimi-native-tools": patch
"@moonshot-ai/kimi-code": patch
---

Close the fail-open holes where "cannot tell" and "nothing to lose" shared a return value (B2 of the 2026-10-12 audit).

**Safety reviews run again in yolo mode** (`agent-core-v2`). The `guardian-review` policy was never instantiated, so with `KIMI_GUARDIAN=1` the approval was unconditional — the review, its assessment events and its circuit breaker were all dead code. It is wired back in ahead of `yolo-mode-approve` (order is the semantics: the review decides first). Off by default, so nothing changes without the env var.

**Nested-shell payloads are found behind options** (`agent-core-v2`). The dangerous-command scanner stopped at the first argument it did not recognise as a short option cluster, so `bash --noprofile -c 'rm -rf /'` and `bash -o pipefail -c …` were analysed as "nothing dangerous" and approved under yolo. Value-taking options are now stepped over and only a genuine short-option cluster can carry `-c` — `--norc` is not `-c`, so the fix does not invent payloads either.

**“Unanswerable” no longer means “safe”** (`agent-core-v2`). A failed `git status` counted as a clean worktree, and tower teardown then force-removed uncommitted work; dirtiness is now three-state and anything but `clean` keeps the worktree with a reason. `untrust()` returned early whenever its in-memory flag was already false, so a workspace whose trust record could not be read kept the record and re-trusted itself on the next start; both directions now write through to the store first.

**A session can no longer widen the sandbox to the machine** (`agent-core-v2`). `additionalDirs` from a create/resume payload was merged into workspace-wide state with no removal path, so `["/"]`, `["~"]` or `["/etc"]` opened the whole filesystem for every session in that workspace, permanently. Those targets (plus any ancestor of the workspace) are refused with `CONFIG_INVALID`, the merged dirs are reference counted, and each session releases its hold when it closes or is archived. The project `local.toml` channel keeps its permissive behaviour: a stale config must not stop a workspace from starting.

**Terminal escape sequences cannot be forged** (`pi-tui`). An OSC 8 URL and an OSC 0 window title were written raw, so a control byte inside a model-authored link or a session name could close the sequence and emit one of its own. Both payloads are sanitized, and a link whose `href` carries control bytes renders as plain text instead of a hyperlink.

**One malformed command no longer hides the whole tree** (`tree-sitter-bash`). A word ending in a lone backslash advanced two characters and produced a node past the end of the source, which the recovery path answered by replacing the entire tree with one `ERROR` — every command in it disappeared. The backslash is now consumed as one character (matching bash, which accepts it), and heredoc delimiters are recognised at CRLF line endings as well; a Windows-edited heredoc used to swallow every following line as body text.

**Knowledge scopes respect directory boundaries** (`kimi-native-tools`). Scope matching was a bare string prefix, so `G:/repo` also matched `G:/repo-old` and injected another project's rules; the comparison now normalises separators and requires a path boundary.

**Permission prompts open on the current mode** (`kimi-code`). The start prompt for `/goal` and `/swarm` highlighted "switch to Never Ask" first, so a single Enter could silently drop every future approval prompt. It now opens on the mode already in effect (`ChoicePickerComponent`'s `initialValue` convention); moving the cursor still reaches Never Ask, and the option order, hints and the approval-panel channel are unchanged.

**Sensitive files are matched case-insensitively** (`kimi-code`). On case-insensitive filesystems `.ENV` *is* `.env`, so the only sensitive-data gate on the feedback upload path waved through `.ENV`, `.ENV`-like names, `Server.Key`, `ID_RSA` and `.SSH/config`. Directory, basename and suffix comparisons now fold case; `IGNORED_DIR_NAMES` keeps its exact match.

**Blob routes never serve a live document** (`vis-server`, in the changeset-ignored list). `image/svg+xml` passed the `image/` prefix allow-list and was served inline from the loopback origin the API trusts, so a crafted debug zip plus one click executed script against the API. SVG, HTML, XHTML, XML and any `+xml` type now downgrade to `application/octet-stream` with `Content-Disposition: attachment`, and every blob response carries `Content-Security-Policy: sandbox`. Inline raster images are unaffected.

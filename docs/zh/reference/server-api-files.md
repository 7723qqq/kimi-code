# 文件接口

本页列出读写会话目录、工作区和本机文件的接口，以及二进制与流式端点的 HTTP 行为。通用约定见[服务 API](./server-api.md)。

## 文件系统

会话内文件操作走 `POST /api/v1/sessions/{session_id}/fs:{action}`，请求体为 JSON；动作包括 `list` / `read` / `list_many` / `stat` / `stat_many` / `mkdir` / `search` / `grep` / `git_status` / `git_status:batch` / `pull_request` / `pull_request:batch` / `diff` / `open` / `open-in` / `reveal`。每个动作的请求体还接受可选的 `runtime_id`（string，默认 `local`），用于选择执行操作的运行时；`open`、`open-in` 与 `reveal` 仅在 `local` 运行时上可用。另有：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/workspace/fs:search` | 无会话的工作区搜索（body 携带工作区引用） |
| `POST /api/v1/workspace/fs:suggest` | 无会话的文件补全候选（用于 `@` 文件提及） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话文件（二进制，见下文） |
| `GET /api/v1/fs:browse` | 列出本机目录（文件夹选择器用） |
| `GET /api/v1/fs:home` | 用户主目录与最近工作区 |
| `GET /api/v1/fs:content` | 读取本机任意文件原始字节（仅受 token 保护，谨慎暴露端口） |
| `POST /api/v1/fs:mkdir` | 按绝对路径创建目录 |

### `POST /api/v1/sessions/{session_id}/fs:list`

列出会话工作区目录下的条目，可选递归子目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | 要列出的目录，相对于会话工作目录。默认 `.` |
| `depth` | body | integer | 递归深度，1–10。默认 `1` |
| `limit` | body | integer | 最大条目数，1–1000。默认 `200` |
| `show_hidden` | body | boolean | 包含点文件。默认 `false` |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |
| `exclude_globs` | body | string[] | 额外要跳过的 glob |
| `allow_ignored_globs` | body | string[] | 即使被 gitignore 也指定放行的 glob（如 `.tmp`）。命中项被忽略的祖先目录会自动保留以保证可达。放行点开头路径还需同时传 `show_hidden: true` |
| `sort` | body | string | `type_first`（默认）/ `name_asc` / `name_desc` / `mtime_desc` / `size_desc` |
| `include_git_status` | body | boolean | 附带每个条目的 git 状态。默认 `false` |

成功时 `data` 为 `{ items, truncated }`——`depth` 大于 1 时另附 `children_by_path`（路径 → 条目的映射）。每项是一个条目对象 `{ path, name, kind, size?, modified_at, etag?, mime?, language_id?, is_binary?, is_directory?, is_symlink_to?, git_status?, child_count? }`，其中 `kind` 为 `file` / `directory` / `symlink`，`is_directory` 标记目标为目录的符号链接；`git_status`（仅 `include_git_status: true` 时存在）为 `clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted` 之一；`truncated` 表示 `limit` 或符号链接递归预算截断了列表。通过展开符号链接目录到达的条目每次请求上限为 10,000 条；普通目录递归不受此限制。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在（包括 `path` 不是目录的情况）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:read`

以文本或 base64 读取会话文件的一段内容。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 文件路径，相对于会话工作目录 |
| `offset` | body | integer | 起始字节偏移。默认 `0` |
| `length` | body | integer | 读取字节数，1–10485760（10 MiB）。默认 `1048576`（1 MiB） |
| `encoding` | body | string | `auto`（默认）/ `utf-8` / `base64` |

成功时 `data` 为 `{ path, content, encoding, size, truncated, etag, mime, language_id?, line_count?, is_binary }`，其中 `encoding` 报告实际使用的编码（`utf-8` 或 `base64`），`size` 为文件完整大小。`encoding: "auto"` 时文本以 `utf-8` 返回（非 UTF-8 文本会被转码），二进制内容以 `base64` 返回；`encoding: "utf-8"` 强制按文本读取并拒绝二进制文件。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `40906`：路径是目录
- `40907`：二进制文件却指定了 `encoding: "utf-8"`
- `41302`：文件超过 10 MiB 读取上限
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:list_many`

一次调用列出多个会话目录；失败的路径会折进响应里，而不是让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `paths` | body | string[] | **必填。** 要列出的目录，1–100 条 |

其余请求体字段（`depth`、`limit`、`show_hidden`、`follow_gitignore`、`exclude_globs`、`sort`、`include_git_status`）的类型、取值范围与默认值同 `fs:list`。成功时 `data` 为 `{ results }`——每个请求路径到其条目数组（条目对象见 `fs:list` 的说明）的映射，另附 `truncated_paths`（达到 `limit` 的路径）与 `partial_errors`（失败路径到其 `{ code, msg }` 错误的映射）。

- `40001`：请求体校验失败
- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/fs:stat`

查询会话工作区内单个路径的元信息。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要查询的路径，相对于会话工作目录 |

成功时 `data` 为 `fs:list` 中说明的条目对象。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:stat_many`

一次调用查询多个会话路径的元信息；不存在的路径返回 `null`，不会让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `paths` | body | string[] | **必填。** 要查询的路径，1–1000 条 |

成功时 `data` 为 `{ entries }`——每个请求路径到其条目对象（见 `fs:list` 的说明）的映射，路径不存在时为 `null`。

- `40001`：请求体校验失败
- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/fs:mkdir`

在会话工作区内创建目录。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要创建的目录，相对于会话工作目录 |
| `recursive` | body | boolean | 创建缺失的父目录。默认 `false` |

成功时 `data` 为所建目录的条目对象（见 `fs:list` 的说明）。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：父目录不存在（非递归创建）
- `40919`：路径已存在（非递归创建）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:search`

在会话工作区内模糊搜索文件与目录名。`query` 为空时改为列出顶层条目。当 `{session_id}` 位置携带的是工作区引用（已注册工作区 id 或绝对根路径）而非会话 id 时，搜索针对该工作区执行——这是为尚未创建的草稿会话准备的无会话形式；正式的无会话端点是 `POST /api/v1/workspace/fs:search`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id，或工作区引用 |
| `query` | body | string | **必填。** 搜索文本；`""` 表示列出顶层 |
| `limit` | body | integer | 最大命中数，1–200。默认 `50` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | body | boolean | 为 `true` 时跳过 gitignore 路径。默认 `false` |

成功时 `data` 为 `{ items, truncated }`，每项为 `{ path, name, kind, score, match_positions }`——`kind` 为 `file` / `directory` / `symlink`，`score` 为 0 到 1 之间的模糊匹配得分，`match_positions` 列出匹配到的字符偏移。命中优先按匹配质量排序，同一匹配质量内普通命中排在忽略命中之前；包含忽略命中时可能执行一次补充扫描。`truncated` 表示超出 `limit` 的命中被丢弃。

- `40001`：请求体校验失败
- `40401`：该引用既不是会话，也不是可解析的工作区

### `POST /api/v1/sessions/{session_id}/fs:grep`

在会话工作区内搜索文件内容——默认按字面字符串，`regex: true` 时按正则表达式。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `pattern` | body | string | **必填。** 要搜索的文本或正则 |
| `regex` | body | boolean | 将 `pattern` 视为正则表达式。默认 `false` |
| `case_sensitive` | body | boolean | 默认 `true` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的文件 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的文件 |
| `follow_gitignore` | body | boolean | 跳过 gitignore 的路径。默认 `true` |
| `max_files` | body | integer | 最多扫描的文件数，1–10000。默认 `200` |
| `max_matches_per_file` | body | integer | 每个文件保留的匹配数，1–10000。默认 `50` |
| `max_total_matches` | body | integer | 总共保留的匹配数，1–100000。默认 `5000` |
| `context_lines` | body | integer | 每个匹配携带的上下文行数，0–10。默认 `2` |

成功时 `data` 为 `{ files, files_scanned, truncated, elapsed_ms }`，其中 `files` 的每项为 `{ path, matches }`，每个匹配为 `{ line, col, text, before, after }`（`before` / `after` 最多携带 `context_lines` 行上下文）；`truncated` 表示某个匹配配额截断了结果。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `41305`：搜索超时

### `POST /api/v1/sessions/{session_id}/fs:git_status`

读取 git 状态，可选限定在一组路径内。提供 `root` 时条目路径相对于该目录；省略时状态覆盖整个 Git 工作树，条目路径相对于仓库根。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `root` | body | string | 要限定范围的工作区目录。省略时状态覆盖整个 Git 工作树；相对值从会话工作目录解析 |
| `paths` | body | string[] | 将状态限定在这些路径。提供 `root` 时相对路径从 `root` 解析，否则从会话工作目录解析 |
| `include_pull_request` | body | boolean | 是否附带关联的拉取请求。默认 `true` |

成功时 `data` 为 `{ branch, ahead, behind, entries, additions, deletions, pullRequest }`，其中 `entries` 把每个变更路径映射到其状态（`clean` / `modified` / `added` / `deleted` / `renamed` / `untracked` / `ignored` / `conflicted`），`pullRequest` 为 `{ number, state, url }`（`state` 为 `open` / `merged` / `closed` / `draft`）或 `null`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40908`：git 不可用（不是仓库，或没有 git 可执行文件）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:git_status:batch`

一次读取多个工作区目录的 git 状态。某个目录失败会并入 `errors`，而不是让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `roots` | body | string[] | **必填。** 要检查的工作区目录，1–32 项 |
| `include_pull_request` | body | boolean | 是否在每个结果中附带关联的拉取请求。默认 `true` |

成功时 `data` 为 `{ results, errors }`。`results` 把每个成功的根映射到与 `fs:git_status` 相同的状态对象；`errors` 把每个失败的根映射到其 `{ code, msg }` 错误，错误码与单目录动作一致。

- `40001`：请求体校验失败
- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/fs:pull_request`

读取某个会话工作区目录关联的拉取请求。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `root` | body | string | 要检查的工作区目录。默认为会话工作目录；相对值从该目录解析 |

成功时 `data` 为 `{ number, state, url }`（`state` 为 `open` / `merged` / `closed` / `draft`），未找到拉取请求时为 `null`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40908`：git 不可用（不是仓库，或没有 git 可执行文件）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:pull_request:batch`

一次读取多个工作区目录的拉取请求。某个目录失败会并入 `errors`，而不是让整个请求失败。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `roots` | body | string[] | **必填。** 要检查的工作区目录，1–32 项 |

成功时 `data` 为 `{ results, errors }`。`results` 把每个成功的根映射到与 `fs:pull_request` 相同的拉取请求对象或 `null`；`errors` 把每个失败的根映射到其 `{ code, msg }` 错误。

- `40001`：请求体校验失败
- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/fs:diff`

返回某个会话工作区目录内单个文件的 unified git diff。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要 diff 的文件，相对于 `root` |
| `root` | body | string | 要检查的工作区目录。默认为会话工作目录；相对值从该目录解析 |

成功时 `data` 为 `{ path, diff, truncated }`，其中 `diff` 为 unified diff 文本，`truncated` 表示过长的 diff 被截断。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40908`：git 不可用（不是仓库，或没有 git 可执行文件）
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:open`

用宿主操作系统的默认程序打开会话文件。仅限 local 运行时。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要打开的文件，相对于会话工作目录 |
| `line` | body | integer | 在处理程序支持时跳转到的行号（正整数） |

成功时 `data` 为 `{ opened: true }`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

### `POST /api/v1/sessions/{session_id}/fs:open-in`

在指定的宿主应用程序中打开会话文件或目录。仅限 local 运行时。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `app_id` | body | string | **必填。** 目标应用：`finder` / `cursor` / `vscode` / `iterm` / `terminal` |
| `path` | body | string | **必填。** 要打开的文件或目录，相对于会话工作目录 |
| `line` | body | integer | 在应用支持时跳转到的行号（正整数） |

成功时 `data` 为 `{ opened: true }`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区
- `50001`：应用启动失败

### `POST /api/v1/sessions/{session_id}/fs:reveal`

在宿主操作系统的文件管理器中显示会话文件。仅限 local 运行时。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | body | string | **必填。** 要显示的文件，相对于会话工作目录 |

成功时 `data` 为 `{ revealed: true }`。

- `40001`：请求体校验失败
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

### `GET /api/v1/sessions/{session_id}/fs/{path}:download`

从会话工作区下载文件；`{path}` 是相对于工作区的文件路径，并带字面量 `:download` 后缀。响应为支持 Range 与 ETag 的二进制流——见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `path` | path | string | **必填。** 相对于工作区的文件路径，加 `:download` 后缀 |
| `runtime_id` | query | string | 从哪个运行时读取。默认 `local` |

- `40001`：路径缺失或为空
- `40401`：会话不存在
- `40409`：路径不存在
- `41304`：路径越出会话工作区

### `POST /api/v1/workspace/fs:search`

`fs:search` 的无会话形式：工作区改由请求体而非 URL 携带。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | **必填。** 已注册工作区 id 或绝对根路径（当场注册） |
| `query` | body | string | **必填。** 搜索文本；`""` 表示列出顶层 |
| `limit` | body | integer | 最大命中数，1–200。默认 `50` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `follow_gitignore` | body | boolean | 为 `true` 时跳过 gitignore 路径。默认 `false` |
| `runtime_id` | body | string | 在哪个运行时上搜索。默认 `local` |

成功时 `data` 为 `{ items, truncated }`，命中结构与排序同 `fs:search`。

- `40001`：请求体校验失败
- `40410`：工作区不存在，且不是可用的绝对路径

### `POST /api/v1/workspace/fs:suggest`

在无会话的情况下给出工作区内的文件与目录补全候选——即输入框中 `@` 文件提及的后端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace` | body | string | **必填。** 已注册工作区 id 或绝对根路径（当场注册） |
| `query` | body | string | **必填。** 要补全的部分路径文本 |
| `limit` | body | integer | 最大候选数，1–200。默认 `50`；fd 搜索最多返回 `20` 条 |
| `follow_gitignore` | body | boolean | 为 `true` 时跳过 gitignore 路径。默认 `false` |
| `show_hidden` | body | boolean | 包含点文件。默认 `false`；fd 搜索始终包含 |
| `stream` | body | boolean | 为 `true` 时以 NDJSON 返回 preview/final 事件。默认 `false` |
| `include_globs` | body | string[] | 只保留匹配这些 glob 之一的路径 |
| `exclude_globs` | body | string[] | 跳过匹配这些 glob 的路径 |
| `runtime_id` | body | string | 在哪个运行时上补全。默认 `local` |

成功时 `data` 为 `{ items, truncated }`，每项为 `{ path, name, kind, score, match_positions }`，命中结构同 `fs:search`。候选优先按匹配质量排序，同一匹配质量内普通候选排在忽略候选之前。fd 可用时采用与本地 `@` 补全相同的策略：始终包含隐藏路径，每个 root 每轮最多扫描 100 条，最多返回 20 条；超出扫描上限的匹配可能遗漏。包含忽略候选时可能执行一次 `--no-ignore-vcs` 补充扫描；fd 不可用时回退到 ripgrep/Node 实现。

使用 `stream:true` 时，响应改为 NDJSON，而不是单个 JSON 对象。每个响应包的 `data` 包含 `phase`（`preview`、`final` 或 `error`）以及相同的结果字段。preview 携带普通 fd 候选且 `truncated:true`；ignored 扫描完成后的 final 用于替换 preview。关闭连接会取消搜索。

- `40001`：请求体校验失败
- `40410`：工作区不存在，且不是可用的绝对路径

### `GET /api/v1/fs:browse`

列出某个本机目录的子目录——文件夹选择器的后端。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | query | string | 绝对目录路径。默认用户主目录 |

成功时 `data` 为 `{ path, parent, entries }`，其中 `path` 为解析后的目录，`parent` 为其父目录（文件系统根处为 `null`），每条目为 `{ name, path, is_dir: true }`。

- `40001`：`path` 不是绝对路径
- `40409`：路径不存在
- `40411`：权限不足

### `GET /api/v1/fs:home`

返回文件夹选择器的落地数据。无参数。

成功时 `data` 为 `{ home, recent_roots }`，其中 `home` 为用户主目录，`recent_roots` 列出已注册工作区的根目录。

### `GET /api/v1/fs:content`

以流式返回本机文件系统上任意文件的原始字节——仅受 API token 保护，暴露端口时务必谨慎。支持 Range 请求与 ETag 缓存；见 [二进制与流式端点](#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | query | string | **必填。** 绝对文件路径 |

- `40001`：`path` 不是绝对路径，或不是普通文件
- `40409`：路径不存在
- `40411`：权限不足
- `40906`：路径是目录

### `POST /api/v1/fs:mkdir`

按绝对路径在本机文件系统上创建一个目录——文件夹选择器「新建文件夹」的后端。非递归：父目录必须已存在。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `path` | body | string | **必填。** 绝对目录路径 |

成功时 `data` 为 `{ path }`。

- `40001`：`path` 不是绝对路径
- `40409`：父路径不存在
- `40411`：权限不足
- `40919`：路径已存在

## 二进制与流式端点

以下端点返回二进制流而非 JSON 载荷，各端点的 HTTP 能力并不相同：

| 方法与路径 | 说明 | Range 分段（206） | ETag / 304 |
| --- | --- | --- | --- |
| `GET /api/v1/files/{file_id}` | 下载已上传文件 | 支持 | 不支持（会发送 `etag` 头，但不处理 `If-None-Match`） |
| `GET /api/v1/sessions/{session_id}/fs/{path}:download` | 下载会话工作区文件 | 支持 | 支持 |
| `GET /api/v1/fs:content` | 读取本机任意文件（仅受 token 保护，谨慎暴露端口） | 支持 | 支持 |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流） | 不支持 | 不支持 |

错误语义也不相同：`GET /api/v1/files/{file_id}`、`GET /api/v1/fs:content` 与会话 `:download` 对失败返回真实 4xx / 500 状态码，响应体仍是标准 [响应信封](#响应信封)。会话导出仍以 HTTP 200 返回错误信封。普通 JSON RPC 端点继续保持几乎总是 200 的约定，客户端仍需检查信封中的 `code`。

# Tasks — git 记忆层的覆盖扩展

每条任务给出可验证的验收标准。命令一律在 `packages/agent-core-v2` 下跑（`bun run test`）。

## T1 — 索引与取数

改：`src/features/gitMemory/types.ts`、`gitReader.ts`、`cache.ts`

- [x] `CommitRecord` 增 `body: string`；`GitMemoryIndex` 增 `dirs: readonly string[]`。
- [x] `GIT_MEMORY_INDEX_VERSION` 递增到 2。
- [x] `git log` 的 format 改为 `%H%x09%ad%x09%an%x09%s%x00%b%x00`，git 进程数不增加。
- [x] 解析：body 含换行与 tab 时仍能正确切分；body 为空时得到空串而非 `undefined`。
- [x] 新增 `readRepoTree()`：跑 `git ls-tree -d -r --name-only HEAD`，返回目录路径数组；失败时返回 `undefined` 而不是抛错。
- [x] `buildIndex` 的 `byPath` 保留窗口内该路径的**全部**提交位置。
- [x] 缓存写入 `dirs`，版本不匹配时判 miss。

**验收**

- [x] `bun test --isolate test/features/gitMemory/gitReader.test.ts test/features/gitMemory/cache.test.ts` 全过。
- [x] 新增用例：构造 4 个提交触碰同一路径，`byPath[path].length === 4`（改前是 3）。

## T2 — 投影渲染

改：`src/features/gitMemory/projection.ts`

- [x] `projectCommit` 渲染 body：subject 与 body 都缩进两空格；body 为空时不产生多余空行；body 内部换行原样保留。
- [x] 新增 `projectRepoTree(dirs, depth)`：只输出分段数 ≤ depth 的目录行；为空时返回 `''`。
- [x] 新增 `projectDirBlock(path, commits, seen)`：输出 `<dir-memory path="...">` 子段。
- [x] `<file-memory>` 能容纳 `<dir-memory>` 子段。

**验收**

- [x] `bun test --isolate test/features/gitMemory/projection.test.ts` 全过。
- [x] 渲染结果里不出现统计量（计数、频率、占比、祈使句）——既有三条断言继续有效。
- [x] 同一份索引渲染两次逐字相同。

## T3 — 服务接线

改：`src/features/gitMemory/gitMemoryService.ts`

- [x] `repoBlock()`：最近 25 个提交（每条带 body）+ `<repo-tree>`（深度 ≤3）+ 无 `applies_to` 的记忆条目。
- [x] `fileBlock()`：该文件最近 8 个提交（带 body）+ `<dir-memory>` 子段（该文件所在目录最近 5 个提交）。
- [x] 目录历史按 `dir/` 前缀匹配，不误匹配同名前缀的兄弟目录。
- [x] 目录历史结果在会话内缓存。
- [x] 去重规则不变：每文件一次；同一提交第二次只输出 `see commit <sha> above`（文件通道与目录通道共用）。
- [x] flag 关闭时三段都返回 `''` 且零 git 进程。
- [x] **（实施期新增）** 记忆库故障时只丢 `<memory>` 段，git 投影照常注入。

**验收**

- [x] `bun test --isolate test/features/gitMemory/gitMemoryService.test.ts` 全过。
- [x] 新增用例：`fileBlock('src/a.ts')` 的结果含 `<dir-memory path="src">`。

## T4 — `RepoMap` 工具

新增：`src/features/gitMemory/tools/repoMapTool.ts`、`repo-map.ts`、`repo-map.md`；改：`src/index.ts`、`session/agentLifecycle/profile/profiles.ts`、`agent/permissionPolicy/policies/default-tool-approve.ts`

- [x] `RepoMap({ path?, depth? })` 返回 `git ls-tree -r -t --name-only HEAD -- <path>` 的原始行，按 depth 过滤。
- [x] `path` 缺省为整个仓库；`depth` 缺省 3。
- [x] 输出超过上限行数时截断并注明。
- [x] 由 `git_memory` flag 控制注册（`when:` 选项）。
- [x] **（实施期补）** 加进 `AGENT_TOOLS` 与 `CODER_TOOLS` 的 profile 白名单——`when:` 只管 flag，profile 白名单才是最终闸门。
- [x] **（实施期补）** 加进默认自动批准名单（只读工具）。
- [x] `src/index.ts` 引入模块以触发注册。

**验收**

- [x] 端到端执行一次工具，断言返回包含预期路径行。
- [x] flag 关闭时该工具不出现在工具列表里。

## T5 — 门禁与清单

- [x] `bun run check:no-comments` 通过（`packages/agent-core-v2` 是免注释区）。
- [x] `bun run check:git-memory` 通过（新增的 tools 目录也在扫描范围内）。
- [x] `bun run lint` 在我改动的文件上无 error。
- [x] `bun run typecheck`（包内）通过。
- [x] 重跑 `bun run gen:state-manifest` 与 `bun run gen:wire-manifest`，生成无差异（wire manifest 不枚举工具名）。

**验收**

- [x] 上述命令全部退出码 0。
- [x] `git status` 无意外生成物。

## T6 — 端到端验证

- [x] 真跑一次 `Read` 工具，断言工具结果里出现 `<file-memory>`——既有回归测试 `appends the git memory block to the read result`（`test/os/backends/node-local/tools/read.test.ts:428`）覆盖，真实会话 wire 记录里也确认了 `<file-memory>` 与 `<dir-memory>` 同时出现。
- [x] 真跑一次 headless 会话，从落盘的 wire 记录里核对 `<repo-memory>` 含 body、含 `<repo-tree>`，并记录 token 增量（观察值，不作门禁）。

**验收**

- [x] 端到端测试在包内套件里通过。
- [x] token 增量写进 `progress.md`。

## 任务顺序

T1 → T2 → T3 → T4 → T5 → T6。

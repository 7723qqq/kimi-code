# Progress — git 记忆层的覆盖扩展

需求见 `requirements.md`，设计见 `design.md`。本文件记录实施过程、端到端暴露的缺陷与验证证据。

## 实施状态

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| T1 索引与取数 | ✅ | `CommitRecord.body`、`GitMemoryIndex.dirs`、`byPath` 不再截断、索引版本 2 |
| T2 投影渲染 | ✅ | body 逐字渲染、`<repo-tree>`、`<dir-memory>` 子段 |
| T3 服务接线 | ✅ | L1 = 25 提交 + 目录树；L3 = 8 提交 + 5 条目录历史 |
| T4 `RepoMap` 工具 | ✅ | 新工具 + profile 白名单 + 自动批准名单 |
| T5 门禁与清单 | ✅ | `check:no-comments`、`check:git-memory`、`lint`、`typecheck` 全过；清单无差异 |
| T6 端到端验证 | ✅ | 真实 headless 会话，见下方证据 |

## 端到端暴露的三个缺陷（都已修）

这一轮最有价值的产出不是新功能，是**真实会话暴露的三个既有缺陷**。

### 缺陷 1 — 记忆库故障拖垮整个 git 注入（既有，最严重）

**现象**：`fileBlock()` 先取记忆条目再渲染 git 投影。记忆库打不开时（MiniDb 被别的进程锁住）抛异常，`fileBlock()` 整个 catch 掉返回 `''`——**连 git 提交投影一起丢了**。

**日志证据**（真实 headless 会话，`~/.kimi-code/sessions/.../logs/kimi-code.log`）：

```
WARN  git memory repo block failed
  Error: memory store at C:/Users/Administrator/.kimi-code/store/memory failed to open
  (database is locked by another process: …)
```

**修法**：记忆库读取单独包一层 `safeMemories()`，失败只丢 `<memory>` 段，git 投影照常注入；日志每会话只报一次。

**为什么重要**：`CONVENTIONS.md` 的"静默失败比崩溃更严重"。记忆库是单进程 SQLite，第二个进程必然拿不到锁——而两个 kimi-code 同时跑是常态。

### 缺陷 2 — `RepoMap` 的 `path` 语义与文档不符

**现象**：工具描述写"仓库相对路径"，实现却套了 `toRepoPath()`，会拼上工作目录的仓库相对前缀。在仓库子目录下工作时，模型给的仓库相对路径被拼成 `apps/kimi-code/packages/...` → 查不到。模型在第一次真实调用时就撞上了，自己在回答里指出了这个不一致。

**修法**：先按仓库相对路径查；没有命中时再按工作目录前缀查一次。最多两条 git 命令，常见情况只一条。工具描述同步改成"先按仓库根目录，命中不了再按工作目录"。

### 缺陷 3 — 新工具进不了工具列表

**现象**：工具注册了、flag 也是开的，但 `llm.tools_snapshot` 里没有 `RepoMap`。

**根因**：profile 里写死了每个 agent 可用的工具清单（`src/session/agentLifecycle/profile/profiles.ts`），`isToolActive()` 只放行清单内的工具。`registerAgentToolService` 的 `when:` 只管 flag，管不了 profile 白名单。

**修法**：`RepoMap` 加进 `AGENT_TOOLS` 与 `CODER_TOOLS`，并加进默认自动批准名单（只读工具，和 `Read`/`Grep`/`Glob` 同级）。

## 实施期偏离

1. **`git log` 的 NUL 分隔符改成首尾都带。** 初版用 `--format=%H%x09%ad%x09%an%x09%s%x00%b`，实测发现 git 在每条记录**正文之后**才补分隔换行，于是下一条提交的 header 会落进上一条的正文字块。改成 `%H%x09%ad%x09%an%x09%s%x00%b%x00` 后，"每条提交贡献两个 NUL"，奇偶配对恒成立。

2. **去掉了重复的 `rev-parse HEAD`。** `readGitHistory` 里那条命令与 `readRepoHead` 的三合一命令重复。改成把 `headSha` 作参数传进去，索引重建的 git 命令数从 3 降到 2（加上 `ls-tree` 共 3 条）。

3. **`byPath` 不再截断到 3 条。** `buildIndex` 原来每个路径只留 3 个位置。现在保留窗口内全部位置，支撑 8 条文件历史与目录历史。

4. **目录历史在运行时算，不进倒排表。** 1,063 个目录各存一份位置表会让索引膨胀到不可用；改成扫 `index.commits` 做前缀匹配，结果按目录缓存。

5. **`ensureHead` / `loadHead` / `repoRoot` / `pathPrefix` 从 private 改成 protected。** 为了让测试能注入假的仓库头（`loadIndex` 早就是 protected，同一个理由）。

6. **顺手修了两个既有的 `typescript/return-await` lint error。** `readTool.ts:277` 与 `writeTool.ts:113` 的 `return withFileMemory(...)` 没 await，导致 `finally` 里的 `lease.dispose()` 在注入块取完之前就跑掉。这是 git 记忆注入路径上的真问题，改成 `return await`。

7. **加了 `RepoMap` 之后，tower worker profile 也必须加。** `test/features/tower/workerProfile.test.ts` 断言"tower worker 拥有 coder 的全部工具（除 Agent/AgentSwarm）"，所以 `TOWER_WORKER_TOOLS` 也要加 `RepoMap`。这是我自己引入的回归，包级套件当场抓到并已修。

## 验证证据

### 单测

`cd packages/agent-core-v2 && bun test --isolate test/features/gitMemory/` → **64 pass / 0 fail**。

覆盖：body 逐字渲染与空 body 不留空行、`<repo-tree>` 深度筛选、`<dir-memory>` 与文件块的顺序与去重、`byPath` 不截断、索引版本失效、`ls-tree` 命令参数、NUL 分隔解析（含正文含 tab/空行）、`RepoMap` 的三种路径解析与深度过滤、记忆库故障时 git 投影照常注入。

### 包级套件对比

同一批 5 个文件，改动前后与 HEAD 基线**逐字一致**：

| | pass | fail | 测试数 |
| --- | --- | --- | --- |
| HEAD（干净 worktree） | 373 | 9 | 382 |
| 改动后的工作树 | 373 | 9 | 382 |

失败文件集合完全相同（`test/tool/tool.test.ts`、`test/wire/resume.test.ts`、`test/agent/loop/loop.test.ts`、`test/app/config/config.test.ts`、`test/features/plan/plan.test.ts`），全部是 PowerShell 工具进快照导致的陈旧快照。

### 门禁

| 命令 | 结果 |
| --- | --- |
| `bun run check:no-comments` | OK（2161 files） |
| `bun run check:git-memory` | OK（8 files，新工具文件在扫描范围内） |
| `bunx oxlint --type-aware` | 我改动的文件 0 error（详见下方"既有失败"） |
| `bun run typecheck`（包内） | 通过 |
| `gen:state-manifest` / `gen:wire-manifest` | 重跑无差异（wire manifest 不枚举工具名） |

### 既有失败（与本改动无关，已实测确认）

包级套件有 5 个文件失败（`test/tool/tool.test.ts`、`test/wire/resume.test.ts`、`test/agent/loop/loop.test.ts`、`test/app/config/config.test.ts`、`test/features/plan/plan.test.ts`），全部是**同一个陈旧内联快照**：HEAD 里已经有 `PowerShell` 工具（`git grep -l PowerShell HEAD -- packages/agent-core-v2/src/agent/tools` 有命中），但这 5 个文件的快照里都没有它。

在 HEAD 的干净 worktree（`git worktree add --detach .tmp/head-check HEAD`）里跑同样 5 个文件：**同样 9 条快照失败**，与改动后的工作树完全一致。用完已删除该 worktree。

`scripts/upstream-ledger.mjs` 的两个 lint error 属于工作区里他人未提交的 WIP，未触碰。

## 端到端验证证据（真实 headless 会话）

两轮真实会话（`bun src/main.ts -p ...`，`KIMI_CODE_EXPERIMENTAL_GIT_MEMORY=1`，模型 MiniMax-M3.1-Flash），wire 记录在 `~/.kimi-code/sessions/wd_kimi-code_901118472ae3/session_3b70e5f4-.../agents/main/wire.jsonl`。

### 第一轮（修缺陷之前）

模型**没有真的调用** RepoMap（它把 "RepoMap" 当成项目里要找的东西，去读了源码），而且 Read 的工具结果里**没有任何 `<file-memory>` 块**。日志显示：

```
WARN  git memory repo block failed
WARN  git memory file block failed      (每个文件一次)
  Error: memory store … failed to open (database is locked by another process)
```

根因是缺陷 1：记忆库被本会话锁住 → `fileBlock()` 整体抛错 → 连 git 投影一起丢。工具列表 89 个，**没有 RepoMap**（缺陷 3）。

### 第二轮（修完三个缺陷之后）

| 项 | 结果 |
| --- | --- |
| 工具列表 | **90 个**，`RepoMap` 在列；模型真的调用了它并拿到 `packages/agent-core-v2/src/features/gitMemory` 下的 6 个受跟踪路径（`tools/` 目录尚未提交，所以不在 HEAD 树里——符合预期） |
| 系统提示 | `systemPromptChars` **69,386 → 88,081**（注入真的落地了，+18,695 字符） |
| 首轮 input token | **59,888 → 65,412**（Δ ≈ **+5.5k token/会话**，L1 部分） |
| Read 工具结果 | 含 `<file-memory path="packages/agent-core-v2/src/features/gitMemory/types.ts">`，6,709 字符（8 条提交的原始投影） |
| 目录历史 | 含 `<dir-memory path="packages/agent-core-v2/src/features/gitMemory">`，5 条提交；去重生效（重复提交输出 `see commit bf2c219 above`） |
| 记忆库故障 | 日志只剩**一条** `git memory entries unavailable; injecting git history only`，git 投影照常注入 |

`<repo-memory>` / `<repo-tree>` 的正文不落 wire 记录（系统提示只存 hash 与字符数），其内容由单测逐字断言。

### 体量小结（本仓库）

| 通道 | 体量 |
| --- | --- |
| L1 `<repo-memory>` + `<repo-tree>` | 18,695 字符 ≈ 5.5k token/会话 |
| L3 `<file-memory>` + `<dir-memory>` | 约 8–9k 字符 ≈ 2.4k token/次读文件 |

## 未验证 / 待办

- **flag 开/关的任务行为对照**未做：需要一批同类任务各跑多次，对比改动文件数、测试失败数、完成轮数。按本 spec 的纪律，注入量本身不设阈值，但"任务是否真的变好"仍需实测。
- **跨仓库的 token 增量**未测：只在本仓库测过（见上）。
- **`.kimi-code/git-memory.json` 未进 `.gitignore`**：索引缓存落在用户仓库里，改动后体积从约 3.3MB 涨到约 6MB（含 body 与完整倒排表）。这是既有行为，但值得加一条 `.gitignore`。
- **`RepoMap` 未进 `EXPLORE_TOOLS`**：explore 子代理仍靠 Glob 探索；要不要给它，等实际用下来再定。

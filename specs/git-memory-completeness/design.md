# Design — git 记忆层的覆盖扩展

需求见 `requirements.md`。本文件给出落点、格式、取数方式与代价实测。

## 0. 一句话设计

**把 git 里本来就有、但之前没搬的东西补上：commit body、目录树、目录级历史，再加一个按需拉取仓库结构的工具。**

```
仓库 git 历史 ──窗口扫描──► 索引缓存（按 HEAD sha）
                              ├─ commits[]：sha/date/author/subject/body/files
                              ├─ byPath{}：路径 → 全部提交位置（不再截断）
                              └─ dirs[]：HEAD 的全部目录（1063 条）
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   L1 会话启动                 L3 工具结果                  RepoMap 工具
   25 提交 + body             文件 8 提交 + body          子树的 ls-tree 原文
   + 深度 3 目录树            + 目录 5 提交
```

## 1. 落点

| 文件 | 改动 |
| --- | --- |
| `src/features/gitMemory/types.ts` | `CommitRecord` 增 `body`；`GitMemoryIndex` 增 `dirs`；`GIT_MEMORY_INDEX_VERSION` 1→2；新增体量常量 |
| `src/features/gitMemory/gitReader.ts` | `git log` 的 format 加 `%b`；新增 `readRepoTree()`；`runGit` 改为可复用导出 |
| `src/features/gitMemory/cache.ts` | `byPath` 不再按路径截断；缓存新增 `dirs` |
| `src/features/gitMemory/projection.ts` | `projectCommit` 渲染 body；新增 `projectRepoTree()`；新增 `projectDirBlock()` |
| `src/features/gitMemory/gitMemoryService.ts` | `repoBlock()` 追加树；`fileBlock()` 追加目录历史；新增 `repoMap()` |
| `src/features/gitMemory/tools/repoMapTool.ts` | 新增 `RepoMap` 工具 |
| `src/index.ts` | 引入工具模块以触发注册 |

## 2. 取数

### 2.1 body 并入已有命令

现在的元信息命令：

```
git -c core.quotePath=false log -1500 --date=short --format=%H%x09%ad%x09%an%x09%s
```

改成：

```
git -c core.quotePath=false log -1500 --date=short --format=%H%x09%ad%x09%an%x09%s%x00%b
```

`%x00` 是 NUL 分隔符——body 里可以安全地含任意字符（换行、tab），不会破坏解析。解析时先按 `\0` 切记录，再按 `\t` 切字段。**git 进程数不变。**

### 2.2 目录树新增一条命令

```
git -c core.quotePath=false ls-tree -d -r --name-only HEAD
```

只在索引重建时跑一次，结果进缓存。`-d` 只出 tree 对象（目录），`-r` 递归。

### 2.3 git 进程总数

| 场景 | 进程数 |
| --- | --- |
| 缓存命中 | 0 |
| 缓存未命中（重建） | 4（rev-parse 三合一 / log 元信息+body / log --name-only / ls-tree） |

`readGitHistory` 里那条独立的 `git rev-parse HEAD` 与 `readRepoHead` 重复，去掉，改用 `readRepoHead` 已经拿到的 `headSha`。

## 3. 格式

### 3.1 L1 — `<repo-memory>`

```
<repo-memory>
Commit 75969e6 2026-11-01 luozihao
  feat(memory): record git provenance on memory entries
  The memory entries now carry the commit sha they were written in, so a
  reader can audit and revert them.
  packages/agent-core-v2/src/app/memory/memoryPaths.ts
  packages/agent-core-v2/src/app/memory/tools/memoryTool.ts
Commit 62c5e6a 2026-11-01 luozihao
  fix(git-memory): append the commit projection on the main read path
  packages/agent-core-v2/src/agent/tools/os/read/readTool.ts
</repo-memory>
```

排版规则：

- subject 与 body 都缩进两空格，作为同一提交的正文；
- body 为空时不产生空行；
- body 里的原始换行保留（逐字），只给首行加缩进；
- 路径列表跟在正文之后；单组提交触碰文件数 > 25 时整段省略路径（沿用既有规则）。

### 3.2 L1 — `<repo-tree>`

```
<repo-tree depth="3">
apps/kimi-code
packages/agent-core-v2/src
packages/agent-core-v2/test
specs/deterministic-git-memory-pipeline
</repo-tree>
```

每行是 `git ls-tree -d -r --name-only HEAD` 的一行原文。深度 = 路径分段数；`depth="3"` 表示只保留分段数 ≤ 3 的目录。目录树为空则整段省略。

### 3.3 L3 — `<file-memory>` + `<dir-memory>`

```
<file-memory path="packages/agent-core-v2/src/features/gitMemory/projection.ts">
Commit 75969e6 2026-11-01 luozihao
  feat(memory): record git provenance on memory entries
  <body>
  packages/agent-core-v2/src/app/memory/memoryPaths.ts
  ...
<dir-memory path="packages/agent-core-v2/src/features/gitMemory">
Commit 4641c20 2026-10-31 luozihao
  feat(git-memory): inject the distilled repo map into the system prompt
  <body>
  packages/agent-core-v2/src/agent/profile/profileService.ts
  ...
</dir-memory>
</file-memory>
```

`<dir-memory>` 是 `<file-memory>` 的子段，两个通道共用同一份会话内去重集合。

### 3.4 `RepoMap` 工具

```
RepoMap({ path?: string, depth?: number })
```

- `path`：仓库根相对路径，缺省为整个仓库；
- `depth`：相对 `path` 的最大深度，缺省 3；
- 输出：`git ls-tree -r -t --name-only HEAD -- <path>` 的原始行，按深度筛选；
- 超过上限行数时返回前若干行并注明已截断（工具结果通道，允许截断；R4 管的是记忆注入通道）。

注册方式照 `WaitFor`：

```ts
registerAgentToolService(IRepoMapTool, RepoMapTool, {
  name: 'RepoMap',
  domain: 'gitMemory',
  when: (accessor) => accessor.get(IFlagService).enabled(GIT_MEMORY_FLAG_ID),
});
```

## 4. 目录历史怎么算

索引里有每个提交的完整路径列表。目录 `d` 的历史 = 窗口内**路径列表中含 `d/` 前缀**的提交，按新到旧取前 5 条。

- 实现：扫 `index.commits`，逐条看 `files` 有没有以 `d/` 开头的；
- 复杂度：1500 提交 × 平均 8 个路径 ≈ 12k 次前缀比较，单次可忽略；
- 同一目录的结果在会话内缓存，避免每次读文件重扫；
- 目录自身也是文件路径的一部分时（如 `d` 就是仓库根），前缀用 `d/` 结尾，避免误匹配同名前缀的兄弟目录。

## 5. 代价实测（本仓库）

| 通道 | 现状 | 改后 |
| --- | --- | --- |
| L1 `<repo-memory>` | +675 token（实测，MiniMax-M3.1-Flash） | 约 21k–28k 字符 ≈ **5–7k token** |
| L1 `<repo-tree>` | 无 | 3,882 字符 ≈ 1k token |
| L3 `<file-memory>` | +408 token（实测） | 约 10k–13k 字符 ≈ **2.5–3.2k token** |
| 索引缓存文件 | 约 0.4MB | 约 1.9MB（body 占大头） |
| 索引重建 | 3 条 git 命令 | 4 条 git 命令，多一次 `ls-tree` |

这些数字都是**常量**，调小只需改 `types.ts` 里的一个数。

## 6. 失败与降级

| 情况 | 行为 |
| --- | --- |
| 非 git 仓库 / git 缺失 | 三层都不注入，`log.debug` |
| git 命令超时 | 同上，`log.warn` |
| 索引损坏 | 丢弃重算 |
| `ls-tree` 单独失败 | 索引照常建立，只是没有 `dirs`；`<repo-tree>` 整段省略 |
| `RepoMap` 调用失败 | 工具返回错误文本，不影响其他通道 |

## 7. 风险

1. **body 是不可信文本**。上游贡献者写的 commit body 会进系统提示。既有 subject 已是同一风险等级；用标签边界隔开，不给它指令语义（R12）。
2. **提示词变长**。系统提示 +5~7k token 每次会话都付。可用常量调小。
3. **缓存文件变大**。`<repo>/.kimi-code/git-memory.json` 约 1.9MB，是未跟踪文件（既有行为）。
4. **目录历史是补充，不是主载荷**。文件自身的 8 条提交已经承载共变信息，目录历史给的是"这块地方最近在忙什么"。

## 8. 测试策略

- `gitReader`：断言新 format 参数、body 解析（NUL 分隔、body 含 tab/换行）、`ls-tree` 命令参数、失败分类。
- `cache`：`byPath` 不再截断；`dirs` 进缓存；版本号变化导致旧缓存 miss。
- `projection`：body 逐字渲染；body 为空不产生空行；`<repo-tree>` 深度筛选；`<dir-memory>` 子段；**渲染结果里不出现任何统计量**；同一索引两次渲染逐字相同。
- `gitMemoryService`：`repoBlock()` 含树；`fileBlock()` 含目录历史；flag 关闭时零进程且三段都返回 `''`。
- `RepoMap`：端到端执行一次工具，断言返回路径行；flag 关闭时不注册。
- **静态检查**：`src/features/gitMemory/` 除 `flag.ts` 外不得 import provider / LLM 客户端 / agent 运行时（既有 `check-git-memory-injection.mjs` 覆盖，新工具文件也在扫描范围内）。
- **端到端行为测试**：真跑一次 `Read` 工具，断言注入块在工具结果里（既有 progress.md 的教训：只测 helper 等于没测接线）。

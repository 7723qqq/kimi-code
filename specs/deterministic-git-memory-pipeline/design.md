# Design — git 原始投影作为记忆层

需求与实测见 `requirements.md`。本文件给出纪律、落点、载荷格式与被否决的方案。

## 0. 一句话设计

**把 git 对象逐字搬进上下文，交给模型自己看出模式。**

```
仓库 git 历史 ──只读 3 条命令──► 窗口缓存（按 HEAD sha）
                                     ├─ L1 会话启动：最近 5 个提交（原始投影）
                                     ├─ L2 轮次开始：用户消息点到路径时，该路径最近 2 个提交
                                     └─ L3 工具结果：Read/Edit/Write 命中文件时，该文件最近 3 个提交
                                        ▲
~/.kimi-code/memory（git 仓库，每次写入一次提交，可 review/revert）
```

**没有事实抽取层，没有统计量，没有 LLM。** 我们只做两件事：选哪些提交、把它们逐字排版。

## 1. 目标函数：省 token 是错的目标

```
E[成本] = P(漏掉必改文件) × C(一次改错) + 注入量 × 1
```

| 项 | 量级 |
| --- | --- |
| 注入一份文件画像 | 800–1700 token |
| 改错一个文件 → 测试红 → 回读 3–5 个文件定位 → 再改 → 再跑测试 | 20K–60K token，3–10 轮 |

比值 **1:12 到 1:35**。所以不设 token / 字符上限，也不优先保精度——漏掉导致失败回环，多给几个不相关路径只是多扫一眼。

## 2. 注入纪律：原始投影

| 允许 | 禁止 |
| --- | --- |
| sha、commit message 原文、author、date、分支名 | 计数、频率、排名、共现次数、占比 |
| 该提交的完整路径列表（`git show --name-only` 原文） | "共现 N 次"、"通常一起改"、"最常改的文件是 X" |
| diff / stat 原文（`git show --stat`、`git show`） | "你必须同时改 X"、"改这里要小心" |
| 已提交文件的原文（记忆仓库的 blob） | 任何祈使句式的结论 |
| | 任何由上述对象计算出来的描述 |

三条独立理由支撑这条纪律：

1. **不稳定性**：让 AI 参与注入就有不稳定性，再强的模型也会幻觉。DiffMem 的检索 agent 路线（让后台 agent 产出注入计划）因此被否决——计划本身是生成内容。
2. **可复核**：逐字来自 git 的内容能用 `git show <sha>` 验证；统计描述验证不了。
3. **实测也支持**：被删掉的统计量形态实测召回只有 0.006–0.123；被保留的"最近 3 个提交原始投影"是 0.463。**纪律与有效性指向同一个方向。**

选择规则必须是结构性的、能一句话说清的（R5）："取最近 N 个"、"取触碰该路径的提交"、"取最近一次"。规则本身不做统计。

## 3. 三层与载荷

### L1 — 会话启动（系统提示）

模板变量 `${repo_memory}`，位置在 `${agents_md}` 之后。flag 关闭时渲染为 `''`。

```
<repo-memory>
Commit 9b5ca3b 2026-10-30 luozihao
  refactor(tui): move todo panel toggling out of the editor keyboard host
  apps/kimi-code/src/tui/components/panels/todo-panel.ts
  apps/kimi-code/src/tui/keyboard/editor-keyboard.ts
Commit 4b0b3b1b1c 2026-10-30 luozihao
  feat(tui): add mouse helpers for dialogs and lists
  ...
</repo-memory>
```

最近 5 个提交。每组：sha、日期、author、subject 原文、路径列表。

### L2 — 轮次开始（reminder 通道）

只在能从最近一条用户消息抽出文件路径时触发（沿用 `knowledgeInjection.ts:65` 的路径正则思路）。抽不到跳过。取前 2 个路径，各带最近 2 个提交。

```
<repo-memory signal="apps/kimi-code/src/tui/tui-state.ts">
Commit 9b5ca3b 2026-10-30 luozihao
  refactor(tui): move todo panel toggling out of the editor keyboard host
  apps/kimi-code/src/tui/components/panels/todo-panel.ts
  ...
</repo-memory>
```

### L3 — 文件进入视野（工具结果尾部，主通道）

`Read` / `Edit` / `Write` 命中某文件时，在该工具结果末尾追加：

```
<file-memory path="apps/kimi-code/src/tui/tui-state.ts">
Commit 9b5ca3b 2026-10-30 luozihao
  refactor(tui): move todo panel toggling out of the editor keyboard host
  apps/kimi-code/src/tui/components/panels/todo-panel.ts
  apps/kimi-code/src/tui/keyboard/editor-keyboard.ts
  apps/kimi-code/src/i18n/locales/en.ts
Commit 4b0b3b1b1c 2026-10-30 luozihao
  feat(tui): add mouse helpers for dialogs and lists
  ...
Commit 5f0a1c9d2e 2026-10-28 luozihao
  ...
</file-memory>
```

**这三组就是召回 0.463 的那个载荷。** 模型自己能从三组路径列表里看出"每次动它都动了 en.ts"——我们不替它说那句话。

**L3 是唯一同时满足四个条件的位置**：模型无需调用任何工具、只在该文件在场时出现、召回接近天花板、时机正确（见到文件后、编辑前）。

### 3.1 唯一的"不铺开"规则（R8）

单组提交触碰文件数 > 25 时，只输出 sha、日期、author、subject，**不列路径，连文件数都不写**。这类提交是批量操作（格式化、重命名），路径列表没有信息量。

## 4. 索引与缓存

```json
{
  "version": 1,
  "repoRoot": "/abs/path",
  "headSha": "…",
  "window": 1500,
  "computedAt": "ISO-8601",
  "commits": [
    { "sha": "9b5ca3b", "date": "2026-10-30", "author": "luozihao",
      "subject": "refactor(tui): move todo panel toggling …",
      "files": ["apps/kimi-code/src/tui/components/panels/todo-panel.ts", "…"] }
  ],
  "byPath": { "apps/kimi-code/src/tui/tui-state.ts": [0, 3, 17] }
}
```

- 缓存存**原始 commit 对象**与**路径倒排索引**。不存任何派生量。
- 命中条件：`version` 与 `headSha` 相同 → 直接读缓存，**不 spawn 任何 git 进程**。
- 未命中：窗口扫描（`%s` 0.2s + `--name-only` 0.9s，窗口 1500），写缓存。
- **不增量**：增量要处理滚动窗口淘汰与倒排索引回退，收益抵不上复杂度；一次重算 1.1s。
- L1 = `commits[0..4]`；L2/L3 = `byPath[path]` 的前 N 项。

## 5. 落点

新目录 `packages/agent-core-v2/src/features/gitMemory/`（与 `features/tower/` 同构）：

| 文件 | 职责 |
| --- | --- |
| `flag.ts` | `registerFlagDefinition('git_memory', { default: false })` |
| `types.ts` | `GitMemoryIndex`、`CommitRecord` |
| `gitReader.ts` | 只跑 `rev-parse HEAD`、`log -N --format=…`、`log -N --name-only`，带超时与失败分类 |
| `cache.ts` | 读写 `<repo>/.kimi-code/git-memory.json`，构建 `byPath` 倒排索引 |
| `projection.ts` | 纯函数：`CommitRecord[] → 注入文本`。只做排版，不做统计 |
| `gitMemoryService.ts` | agent 作用域服务，暴露 `repoBlock()`、`signalBlock(text)`、`fileBlock(path)` |

**注意模块名从 `gitFacts` 改为 `gitProjection`**——它不产出"事实"，只搬运对象。

改动的既有文件：

| 文件 | 改动 |
| --- | --- |
| `agent/profile/profile.ts` | `AgentProfileContext` 增 `repoMemory?: string` |
| `app/agentProfileCatalog/profile-shared.ts` | `systemPromptVars` 增 `repo_memory` |
| `app/agentProfileCatalog/system.md` | `${agents_md}` 之后增一行 `${repo_memory}` |
| `agent/profile/profileService.ts` | 注入 `IGitMemoryService`，取 `repoBlock()` |
| `agent/tools/os/read/readTool.ts` | 结果组装处（`:291` 的 `withAttachmentLocation` 旁）追加 `withFileMemory(...)` |
| `agent/tools/edit/editTool.ts` | 同上 |
| `agent/tools/os/write/writeTool.ts` | 同上 |
| reminder 注册点 | 新增 `repo_memory_signal` variant，实现 L2 |

**L3 复用既有写法**：`fileReadSource.ts:15-25` 的 `withAttachmentLocation` 就是"给工具结果追加上下文"的现成模式；新增 `withFileMemory(result, path, service)` 放同模块旁，三个工具各调一次。

**为什么不在 `toolExecutorService` 统一拦截**：那里只有 `args`，没有可靠的"受影响路径"语义（MCP 工具参数形状各异）。逐个工具显式接线更安全，也符合既有先例。

## 6. 注入协议

| 项 | 规则 |
| --- | --- |
| 去重 | **两级**：每文件每会话只注入一次；同一提交每会话只铺开一次，后续只输出 `see commit <sha> above`。L2 与 L3 共用 |
| 顺序 | `<file-memory>` 追加在工具结果**末尾**，不改变原有输出的任何一行 |
| 上限 | **不按 token/字符裁剪**。唯一约束是 §3.1 的病态提交规则与"取几个提交" |
| token | 只作**观察值**：用 provider 返回的 `inputTotal(usage)`（`human/llm/usage.ts:13`）记录实际增量，写进 `progress.md`；不作门禁 |
| 空段 | 无提交 → 整段省略，不留空标签 |
| 语言 | 英文（C2 模型资产），不翻译、不加 locale key |

## 7. 与系统提示并存

记忆是独立一层：L1 只往系统提示放一段 `<repo-memory>`，L2/L3 走各自通道，都不改写系统提示其余内容。flag 关闭时 `repo_memory` 渲染为 `''`、L2 不注册、三个工具输出逐字不变。

## 8. 与既有记忆机制的关系

| 机制 | 管什么 | 本 spec 的处理 |
| --- | --- | --- |
| `<git-context>`（`gitContext.ts`） | 工作区快照：分支、dirty、最近 3 条提交 | 不动。本 spec 是历史投影 |
| `Memory` 工具（`app/memory/`） | 人/模型显式写的 markdown 记忆 | 保留但改由 git 管理（R16–R25）。**本 spec 的目标是替代它无版本的部分** |
| knowledge 层（`agent/knowledge/`） | 从用户纠正语学到的规范 | 不写。它也走 reminder，靠不同 variant 区分 |
| `features/fileHistory/` | 文件备份与 checkpoint（撤销用） | 无关，只是名字相近 |
| `packages/transcript` | 会话行为轨迹 | 不合并 |

## 9. 被否决的方案

- **任何统计型记忆**（共现、频率、排名、占比、约定词汇表、模块划分）：违反 R4，且实测无效（0.006–0.123）。
- **压成目录**：是派生描述，且丢文件层信息。
- **按 token 裁剪**：目标函数错位；token 随模型而变。
- **让模型主动查询**：存在不主动调用工具的模型。
- **后台检索 agent（DiffMem 路线）**：输出是生成内容，会幻觉。
- **向量检索**：无 embeddings 客户端、无向量索引；结构信号已近天花板。
- **LLM 摘要**：R4；且成本随历史线性增长、有损。
- **改 `knowledge` schema**：`sqliteKnowledge.ts:48` 有 CHECK 约束、无迁移机制。

## 10. 外部实现的阅读结论

读了两个项目的**真实实现**：`Growth-Kinetics/DiffMem`（Python，14806 行；读了 `storage/local_storage.py`、`storage/base.py`、`repo_manager.py`、`frontmatter.py`、`retrieval_agent/agent.py`、`retrieval_agent/resolver.py`）与 `faugustdev/git-context-controller`（Shell；读了 `SKILL.md`、`scripts/gcc_commit.sh`、`scripts/gcc_context.sh`）。

### 10.1 与本 spec 一致

- **提交即版本**：两者的记忆都是真实 git 提交（DiffMem `repo.index.commit`；GCC `git commit -m "$INTENT"` + 追加瘦索引项）。→ R16。
- **索引是指针，正文不复制**：GCC 明确"Instead of duplicating what git already knows"，索引项只有 `hash + intent + note`。→ R25。
- **写入不阻塞在远端**：DiffMem 的 post-commit hook → webhook → out-of-band backup，"Writes are *never* blocked on the backup backend"。→ R17。
- **hook 用哨兵注释管理**：DiffMem 用 `# >>> diffmem-post-commit (managed) >>>` 包裹自己的块，重装时原地替换，不覆盖用户自有 hook。
- **frontmatter 是可查询字段的位置**：DiffMem `frontmatter.py` 定为 "the primary location for queryable fields"。→ R19。

### 10.2 据此改的三处

| 原 spec | 证据 | 改法 |
| --- | --- | --- |
| 把"负知识"列入排除范围 | GCC 的 `note` 字段专存 git 记不住的东西（"rejected alternatives, trade-offs"），`--decisions` 只取带 note 的条目 | **R24**：`note` 升为一等字段 |
| 只说"不按 token 裁剪"，没有替代机制 | DiffMem 的 resolver 用 `must_include` / `if_budget_allows` 两级 + 预算；GCC 用 `--summary` / `--last N` / `--hash` / `--decisions` / `--full` 分档 | **分档启发**采纳进 L1/L2/L3 的三档结构；**截断行为不采纳**——R3 禁止按 token 或字符裁剪注入量。预算单位若将来需要，用字符数（D17） |
| 注入文本里写"必改伙伴"这类结论 | 注入时生成的判断会漂移、会幻觉 | **R4**：注入只写原始投影 |

### 10.3 明确否决的

| 方案 | 为什么否决 |
| --- | --- |
| **DiffMem 的检索 agent**（多轮 `run(command)` 探索记忆仓库，产出 ContentPointer 计划与 synthesis） | 输出是**生成内容**。它确实让主 agent 不查询，但计划本身会幻觉——路径可能不存在、"意图"可能被编造。R4/R15 禁止注入路径出现 LLM |
| DiffMem 的服务端形态（FastAPI + per-user worktree + Hatchet 调度 + ontology 体系） | kimi-code 是本地单用户 CLI，没有多用户服务端这层需求 |
| DiffMem 的 LLM 写实体 + link/redistribute/reabsorb 知识图谱式综合 | 范围远超本 spec；且会改写记忆内容（生成内容进入版本库） |
| GCC 的 worktree-per-branch + TTL 清理 | 那是"智能体工作区"的问题（探索并行、临时分支），不是记忆问题 |
| GCC 的 aiyoucli 向量桥接 | 本仓库无 embeddings 客户端；且结构信号已近天花板 |

### 10.4 读完后被否决的、属于我自己的方案

我原本准备采纳"用独立廉价检索 agent 自动查、主 agent 只收结果"——**这是错的**：注入内容必须是记录下来的事实，不是生成出来的判断。R4/R15 是这条的正式约束。

### 10.5 仍然成立

两个项目的记忆都来自**人/agent 写的内容**，没有一个解决"从代码仓库历史推导仓库知识"。所以第一部分（原始投影）与第二部分（写入记忆的 git 化）确实是两个东西。

## 11. 写入记忆（git 化）

需求见 R16–R25。

### 11.1 现状缺口

`Memory` 工具把 markdown 写到 `~/.kimi-code/memory/{global,projects/<id>,sessions/<id>}`（`memoryStore.ts:47-48`），MiniDb 只做索引（`:56-80`）。缺的是**没有版本**——无法 review、无法回滚、无法回答"这条记忆是谁在什么时候、依据什么写下的"。

### 11.2 设计

- `memoryBaseDir` 变成 **git 仓库**：惰性 `git init`，每次 put/delete 后 `git add -A && git commit`。
- author 固定 `kimi-code memory <memory@local>`；message 体例 `remember:` / `update:` / `forget:`，不出现 agent 身份。
- 无 git / 提交失败：**写入仍然成功**，但工具结果写明"已写入、未提交"及原因（`CONVENTIONS.md:196` 静默失败最严重）。
- 并发：仓库目录加独占锁，提交串行化；持锁超时则跳过提交并报告。
- 回滚：`Memory({ action: 'log' })` / `Memory({ action: 'revert', sha })`，只在该目录内操作。

### 11.3 内容纪律（R23）

- **人可以自由写记忆**——人的内容，不是 AI 生成。
- **agent 只能写引用型条目**：指向一个已存在的 git 对象（sha）+ 原文引用，不写自由散文式的结论。
- 每条记忆声明 `applies_to`：

```
---
applies_to: ["apps/kimi-code/src/tui/**"]
---
# TUI 面板高度预算

dock 上限 18，与面板自算预算手工对齐（todo 5/16/3、updates 12/5）。
```

### 11.4 注入

L3 在命中路径时，把 `applies_to` 匹配的条目注入同一个 `<file-memory>` 块，用 `<memory>` 子段区分。内容是**已提交文件的原文**（R4 允许），带 `sha` 与 `date`：

```
<file-memory path="apps/kimi-code/src/tui/tui-state.ts">
Commit 9b5ca3b 2026-10-30 luozihao
  refactor(tui): move todo panel toggling …
  ...
<memory sha="a1b2c3d" date="2026-10-12" path="global/tui-panel-budget.md">
dock 上限 18，与面板自算预算手工对齐（todo 5/16/3、updates 12/5）。
</memory>
</file-memory>
```

没有 `applies_to` 的条目归入 L1，规模由**条数**控制。

### 11.5 审计闭环

| 能力 | 手段 |
| --- | --- |
| 追溯 | 每条注入带 `(sha, date)`；`git -C ~/.kimi-code/memory show <sha>` 看完整 diff |
| 回滚 | `git revert` 撤掉一条坏记忆 |
| 审查 | 该仓库可配 remote，跨机器同步 |
| 不腐坏 | markdown 是源，MiniDb 是索引；`reconcile()` 已能从磁盘重建 |

## 12. 测试策略

- `gitReader.ts`：注入假进程，断言三条命令参数、超时分类、`not a git repository` 分类。
- `cache.ts`：同 HEAD 零进程；HEAD/version 变化未命中；损坏 JSON 重算；`byPath` 倒排索引正确。
- `projection.ts`：**渲染结果里不出现任何统计量**——断言输出中除 sha、日期、author、subject、路径外没有数字型派生字段（用例覆盖"3 个文件在同一提交里"这类情形）；`>25` 文件的提交只输出头部字段、不输出路径也不输出文件数；同一索引两次渲染逐字相同。
- `gitMemoryService.ts`：flag 关闭时零进程且三段都返回 `''`。
- 工具接线：flag 关闭时 `Read`/`Edit`/`Write` 输出逐字不变；同一文件第二次不重复附加；同一提交第二次只输出 `see commit <sha> above`；工具本身失败时不附加。
- **静态检查**：`packages/agent-core-v2/src/features/gitMemory/` 除 `flag.ts` 外不得 import provider / LLM 客户端 / agent 运行时（R15）。

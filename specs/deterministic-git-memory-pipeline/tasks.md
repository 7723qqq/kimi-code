# Tasks — git 原始投影作为记忆层

设计见 `design.md`，需求与实测见 `requirements.md`。

依赖：**T1 → T2 → T3 → T4 → T5 → T6/T7/T8（可并行）→ T9**；**T10 → T11 → T12/T13 → T14**；**T15** 独立。

全局验证命令（各任务验收在此基础上追加）：

```
cd packages/agent-core-v2 && bun test --isolate test/features/gitMemory
bun run check:no-comments
bun run lint
bun run typecheck
```

---

## T1 — flag 与类型

新增 `packages/agent-core-v2/src/features/gitMemory/flag.ts`（照 `features/tower/flag.ts`）与 `types.ts`。

**验收：**

- `git_memory` 默认 `false`；`KIMI_CODE_EXPERIMENTAL_GIT_MEMORY=1` 时 `flags.enabled('git_memory') === true`。
- `types.ts` 定义 `GitMemoryIndex { version, repoRoot, headSha, window, computedAt, commits, byPath }`、`CommitRecord { sha, date, author, subject, files }`。**类型里不出现任何计数字段**。
- `bun run check:no-comments` → OK。

## T2 — 取数 `gitReader.ts`

只跑三条命令：`rev-parse HEAD`、`log -1500 --format=…`、`log -1500 --name-only`。超时 5s。

**验收（`test/features/gitMemory/gitReader.test.ts`，注入 `IHostProcessService` 假实现）：**

- 断言三条命令参数逐字正确，且带 `-C <cwd>`。
- stderr 含 `not a git repository` → `{ kind: 'unavailable' }`，不抛。
- 超时 → 返回失败并 `log.warn`，不抛。
- spawn 抛错 → 返回失败，不抛。
- 解析出的 `CommitRecord` 的 `subject` 是 commit message **原文**（含完整首行，不做改写）。

## T3 — 缓存 `cache.ts`

读写 `<repoRoot>/.kimi-code/git-memory.json`，构建 `byPath` 倒排索引。

**验收（`test/features/gitMemory/cache.test.ts`）：**

- 同 HEAD 第二次读取：假进程调用次数 **0**。
- `headSha`、`version`、`window` 任一变化 → 未命中。
- JSON 损坏 → 丢弃、重算、`log.warn`。
- `byPath[path]` 指向该路径最近 3 个提交的索引，且顺序为新→旧。
- 写盘失败不阻断内存结果。

## T4 — 投影渲染 `projection.ts`

纯函数：`CommitRecord[] → 注入文本`。**只做排版，不做任何统计。**

**验收（`test/features/gitMemory/projection.test.ts`）：**

- 输出每组包含 sha、日期、author、subject 原文、路径列表，顺序为新→旧。
- **输出中不出现任何统计量**：断言除 sha/日期/author/subject/路径外没有数字型派生字段。用例覆盖"3 个文件在同一提交里"这种情形——渲染结果里不得出现 "3 files"、"共 3 个" 之类。
- 渲染结果里不出现祈使句式结论（断言不含 "must"、"should"、"you need to"）。
- **>25 文件的提交**：只输出 sha、日期、author、subject；**不输出路径，也不输出文件数**。
- 同一索引两次渲染逐字相同；文本全英文，无 locale key。
- 渲染函数**不 import** 任何 provider / LLM 客户端（模块级断言）。

## T5 — 服务编排 `gitMemoryService.ts`

agent 作用域服务，编排 T2→T3→T4，并做会话内去重。

**验收（`test/features/gitMemory/gitMemoryService.test.ts`）：**

- flag 关闭时三个方法都返回 `''`，且假进程调用次数 **0**。
- 非 git 仓库 → 返回 `''`、`log.debug`、不写缓存文件。
- 缓存命中 → 零进程。
- `fileBlock(path)` 对同一 path 第二次调用返回 `''`；与 `signalBlock` 共用同一个会话内 Set。
- **提交级去重**：同一 commit 第二次出现时只输出 `see commit <sha> above`。
- 任一方法都不抛：注入抛错的 reader，断言返回 `''`。

## T6 — L1 接线（系统提示）

改 `agent/profile/profile.ts`、`app/agentProfileCatalog/profile-shared.ts`、`app/agentProfileCatalog/system.md`、`agent/profile/profileService.ts`。

**验收（`test/app/agentProfileCatalog/profile-shared.test.ts` 扩展）：**

- flag 关闭时，同一 context 渲染出的系统提示与改动前**逐字相同**。
- flag 开启时 `<repo-memory>` 出现在 AGENTS.md 注入内容之后，内容为最近 5 个提交的原始投影。
- `repoMemory` 取数失败时系统提示仍渲染成功。

## T7 — L3 接线（三个工具）

在 `agent/tools/os/read/readTool.ts`（`:291` 附近）、`agent/tools/edit/editTool.ts`、`agent/tools/os/write/writeTool.ts` 的结果组装处追加 `withFileMemory(...)`。

**验收（各工具既有测试文件扩展）：**

- flag 关闭时三个工具输出与改动前**逐字相同**。
- flag 开启时 `<file-memory>` 追加在**末尾**，原输出每一行不变。
- 同一文件本会话第二次 `Read`/`Edit`/`Write` 不重复附加。
- 目标文件无历史（新文件）→ 不附加，不产生空标签。
- 工具本身失败（`isError: true`）时不附加。

## T8 — L2 接线（轮次开始）

在 reminder 通道注册 `repo_memory_signal` variant，只在能从最近一条用户消息抽出文件路径时返回内容。

**验收：**

- 用户消息不含路径 → 不注入（不产生空 reminder）。
- 含 `apps/kimi-code/src/tui/tui-state.ts` → 注入该路径最近 2 个提交的原始投影。
- 含多个路径 → 取前 2 个。
- flag 关闭时不注册该 variant。
- 与 knowledge 层的 variant 互不覆盖（同一轮可同时出现）。

## T9 — 门禁与观察

**验收：**

- `bun run check:no-comments` → OK。
- `bun run lint` → 无新增 error。
- `bun run typecheck` → OK。
- `bun run check:no-hardcoded-prose` → 计数**不上升**。
- **token 观察（不作为门禁）**：同一会话分别在 flag 开/关下各跑首次请求，读 provider 返回的 `inputTotal(usage)`（`human/llm/usage.ts:13`），多次取中位数，写入 `progress.md`。**不得**据此设置任何截断阈值（R3）。
- changeset 判定：flag 默认关闭、默认人群感知不到 → 按 `CONVENTIONS.md:150` 判定为不写，结论记入 `progress.md`。

---

## 第二部分：写入记忆的 git 化

### T10 — memory 仓库与自动提交

在 `packages/agent-core-v2/src/app/memory/` 增加仓库层：惰性 `git init`，`put`/`delete` 后提交。

**验收：**

- 首次 `put` 后 `~/.kimi-code/memory` 是 git 仓库且有一次提交；内容与文件一致。
- commit author 为 `kimi-code memory <memory@local>`，message 符合 `remember:` / `update:` / `forget:` 体例，不含 agent 标识。
- git 不存在或目录不可写 → 文件写入仍成功，返回带"未提交"标记，`log.warn`，**不抛**。
- 并发两次写入：锁生效，无半成品提交。
- **瘦索引（R25）**：索引项 = `{ sha, intent, note, applies_to, date }`；断言索引文件大小与正文大小无关；索引损坏时能从 git 重建。

### T11 — `log` 与 `revert` action

扩展 `memoryTool` 的 action 枚举。

**验收：**

- `Memory({ action: 'log' })` 返回最近提交（sha、日期、message），时间降序，默认 20 条。
- `Memory({ action: 'revert', sha })` 后目标文件内容回到该提交之前；`log` 里出现一条 revert 提交。
- 对不存在的 sha → 返回可读错误，不抛。
- 两者都不触碰仓库目录以外的任何路径。

### T12 — `applies_to` 解析与 L3 注入

**验收：**

- `applies_to: ["apps/kimi-code/src/tui/**"]` 命中该目录下文件 → 注入；命不中 → 不注入。
- 注入内容是**已提交文件的原文**（R4 允许），带 `sha` 与 `date` 属性。
- 多条命中时按 `date` 降序；同一 sha 本会话只注入一次（与提交级去重共用 Set）。
- 无 front matter 或无 `applies_to` 的条目**不进入 L3**，改由 L1 输出。
- flag 关闭时全部不注入。

### T13 — 内容纪律：agent 只能写引用型条目（R23）

**验收：**

- 人写的内容（经 `Memory` 工具写入并附 `human: true` 标记或经人确认的路径）可以自由散文。
- **agent 发起的写入若不含已有 git 对象引用（sha）或原文引用，则被拒绝**，工具结果说明原因（R23）。
- 拒绝时不落盘、不提交。
- 写入带 `note` 的记忆 → 提交 message 是 `intent`，`note` 出现在索引项里；不写 `note` 时索引项**无 `note` 键**（不是空串）。

### T14 — 门禁与审计验收

**验收：**

- `bun run check:no-comments`、`bun run lint`、`bun run typecheck` 全绿。
- 审计闭环实测：写入一条记忆 → `git -C ~/.kimi-code/memory log --oneline` 能看到 → `git show` 能看 diff → `Memory({action:'revert'})` 能撤销，三步结果记入 `progress.md`。
- changeset 判定：`Memory` 的 git 化对默认用户可见（每次写入多一次提交、仓库体积变化），按 `CONVENTIONS.md:150` 判定是否写 changeset 并说明理由。

---

## 第三部分：注入纪律的静态检查

### T15 — 注入路径无 LLM 的静态检查

因为 R4/R15 是硬约束，用静态检查把它钉死，防止以后有人把 LLM 或统计逻辑塞回注入路径。

**验收：**

- 新增（或扩展）一个检查脚本，扫描 `packages/agent-core-v2/src/features/gitMemory/`：
  - 除 `flag.ts` 外不得 import provider / LLM 客户端 / agent 运行时；
  - `projection.ts` 不得出现计数型输出（由 T4 的单测覆盖，静态检查只查 import）。
- 该检查接入 `bun run check:*` 系列的某一个门禁（与 `check:no-comments` 同级），在 `ci.yml` 的 lint job 中执行。
- 检查本身有单测：给一个含违规 import 的临时文件 → 检查失败并报出文件与 import 路径。

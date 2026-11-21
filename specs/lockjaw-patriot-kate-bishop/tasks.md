# 实施任务与验收计划

## 执行约定

本文件是完整实施清单，覆盖 [requirements.md](requirements.md) 的 R1–R7，技术选择以 [design.md](design.md) 为准。当前仅已编写规格，下面所有实施任务均未开始、未验收。

采用当前会话内串行实施。先完成前置与高优先级正确性修复，再推进生命周期及容量；不启动子 agent，不在每个绿色批次后等待用户发“继续”。只有需要额外授权、实质性设计选择或确实无法继续的阻塞才中断。

每个修复批次遵循：在现有 owner 测试中加入旧行为复现 → 确认失败原因 → 实现并更新调用方 → 局部回归通过 → 更新实际进度 → 进入下一批。不得一次写入七项失败测试后只修其中一项就交付。下面的测试命令从所示包目录执行，串行运行。

审批通过后在本规格目录创建 `progress.md`，逐项记录变更、准确命令、结果和阻塞；它是执行记录，不改写本需求契约来迎合实现。

## T00 — 固定工作边界与测试 fixture

**依赖：**规格获批。

**动作：**

- 记录 `git status` 和涉及模块的既有差异，确认无其他活跃测试；保护共享工作区的非本任务修改。
- 重读最近的 owning 指导和即将修改的源码，搜索所有构造调用、接口消费者及现有测试 helper。
- 复用现有测试目录、test harness、stubBootstrap、临时目录 helper；fixture 显式提供 homeDir/storeDir/cwd/sessionId/agentId，不能用缺少路径的空对象触发真实库 fallback。
- 设计 A/B 项目、global、两条 session、不同 agent、不同 HEAD 的确定性 fixture；不读取个人目录或凭据。
- 按后续批次逐个加入回归，不创建一次性脚本或新增依赖。

**验收：**

- 初始差异清单可与交付差异核对；明确哪些文件已由其他任务修改。
- fixture 的所有写入目标在测试临时目录内；未初始化路径立即失败，不生成 `undefined/knowledge.db`。
- 每个原始审查问题都映射到后续至少一项明确断言。

## T01 — 知识库连接实例化与路径身份（R1）

**主要文件：**

- `packages/agent-core-v2/src/agent/knowledge/sqliteKnowledge.ts`
- `packages/agent-core-v2/src/agent/knowledge/knowledgeService.ts`
- `packages/agent-core-v2/src/agent/knowledge/knowledge.ts`
- `packages/agent-core-v2/src/index.ts`（仅兼容导出需要时）
- `packages/agent-core-v2/test/agent/knowledge/sqliteKnowledge.test.ts`
- `packages/agent-core-v2/test/agent/knowledge/knowledgeLoop.test.ts`
- `packages/kap-server/test/prompts.test.ts`（只处理既有 cleanup 契约）

**动作：**

1. 加入 A/B 两实例交错打开/读写、dispose、失败打开、close-all 后重开的回归。
2. 把 schema/CRUD 收敛到 `KnowledgeDatabase` 实例；迁移模块级函数调用方，不保留第二套算法。
3. 服务持有实际 handle，引入会话 cwd 解析默认项目路径；保留显式环境覆盖和读不建库语义。
4. 在失败候选连接、成功切换和 dispose 路径完整关闭本实例资源。
5. 保留根 `knowledgeClose()` 显式进程清理接口；服务识别 closed handle。

**必须通过的断言：**

- A 写入 a、B 写入 b，B 打开后 A 只读到 a；A 后写 a2 不出现在 B。
- B 打开失败/正常释放均不影响 A；一个实例切库只改变它自己。
- 同进程两个会话 cwd 不同、各有项目 DB 时，默认命中各自项目库，不误用 app cwd。
- 环境覆盖仍优先；只读未存在 DB 不产生文件；`:memory:` 不创建目录或磁盘 DB。
- 旧 SQLite fixture 的 ID、字段、FTS 排序、确认阈值保持；根 close 接口仍可用于现有消费者。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/agent/knowledge/sqliteKnowledge.test.ts test/agent/knowledge/knowledgeLoop.test.ts
```

消费者回归在 T10 统一执行，不以尚未运行的消费者测试宣称整项最终交付完成。

## T02 — 共享可见性与路径判定基础（R2/R3/R4 的前置）

**主要文件：**

- 新增 `packages/agent-core-v2/src/app/memory/memoryVisibility.ts`
- `packages/agent-core-v2/src/app/memory/memoryPaths.ts`
- `packages/agent-core-v2/src/app/memory/projectIdentity.ts`（原则上复用，不重写身份算法）
- `packages/agent-core-v2/test/app/memory/memoryPaths.test.ts`，以及聚焦的 visibility 测试

**动作：**

- 实现 `MemoryVisibilityContext`、长期路径/metadata 一致性判断、知识 scope 的纯路径判定。
- 复用当前项目身份与旧别名，不创建 app cwd 兜底为别的 session 强行命名的分支。
- 明确 current-session 只精确匹配，不将任意 scopeId 拼接成不受约束的路径。

**必须通过的断言：**

- global/current project/current session 可见；B project、旧 session、未知命名空间不自动可见。
- 路径与条目 metadata 不一致时拒绝注入。
- 已知旧 ID 可映射当前项目；无证据的其他 ID 不映射。
- scope 的精确目录/子目录、相对/绝对路径、点路径、Windows 盘符/分隔符、POSIX 大小写及 repo-old 边界均正确。
- 同远端不同 checkout 沿用现有项目共享身份契约，不因本次修复意外隔离。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/app/memory
```

## T03 — 记录级迁移与失败恢复（R2）

**依赖：**T02。

**主要文件：**

- 新增 `packages/agent-core-v2/src/features/associativeMemory/legacyMemoryMigration.ts`
- `packages/agent-core-v2/src/features/associativeMemory/service.ts`
- `packages/agent-core-v2/src/features/associativeMemory/store.ts`
- `packages/agent-core-v2/src/features/associativeMemory/types.ts`
- `packages/agent-core-v2/test/features/associativeMemory/migration.test.ts`
- `packages/agent-core-v2/test/features/associativeMemory/scopeIsolation.test.ts`
- `packages/agent-core-v2/test/app/memory/memoryStore.test.ts`

**动作：**

1. 先加入 A/B/session 混合源、并发访问和中途失败的复现。
2. 提取迁移协作对象，过滤合法源后选择 immutable destination；不再从公共 writeNote 递归触发迁移。
3. 写入 origin/fingerprint/version/目标 ID 的持久进度；使用确定 ID 和共享 store 队列完成幂等训练。
4. 当前 session 使用内部隔离 store；只在有实际内容时创建。
5. 删除局部迁移冻结全局旧存储的副作用；保留功能开关下的工具选择。
6. 验证变化源版本、忘记状态和被 code 规则阻止的处理。

**必须通过的断言：**

- A 首次导入后，不存在 B/旧 session 内容被写进 A；B 源文件和内容指纹未变。
- global 在相应 global store，当前 session 不被提升为 project；进入 B 时可再迁入 B。
- 同一源版本调用三次、两个 agent 并发、关闭重开都只产生一组迁移规范记录。
- 在 note 写入、训练、complete 标记三个边界各注入失败；重试补齐，不重复、不丢源、不将失败记录标成成功。
- 相同源指纹不会自动复活已忘记迁移记录；变化指纹形成新版本，旧版可作为历史保留。
- 功能开启不冻结其他项目的旧源；功能关闭后 Memory 写入仍可用。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/features/associativeMemory/migration.test.ts test/features/associativeMemory/scopeIsolation.test.ts test/app/memory/memoryStore.test.ts test/app/memory/memoryTool.test.ts
```

## T04 — Git 自动记忆投影隔离（R3）

**依赖：**T02；按优先级在 T03 通过后执行。

**主要文件：**

- `packages/agent-core-v2/src/features/gitMemory/gitMemoryEntries.ts`
- `packages/agent-core-v2/src/features/gitMemory/gitMemoryService.ts`
- `packages/agent-core-v2/src/features/gitMemory/gitMemoryRenderState.ts`
- `packages/agent-core-v2/test/features/gitMemory/gitMemoryService.test.ts`
- `packages/agent-core-v2/test/app/memory/memoryTool.test.ts`

**动作：**

- 将 visibility 接入投影缓存和入口，在 applies_to 前筛选。
- 缓存键纳入可见身份与 store revision，内容变化时清理已解析的 applies_to。
- 同时覆盖 system repoBlock 和工具 fileBlock，不能仅过滤其中一个。

**必须通过的断言：**

- 已提交的 B 记忆无 applies_to 或使用同名文件 glob，均不能进入 A 的 repoBlock/fileBlock。
- 全局、A 项目、A session 的合法记录按既有限额和来源格式出现。
- 同一路径更新 applies_to 后旧 pattern 不再生效。
- 用户主动 Memory 跨项目 search/read 的现有测试继续通过。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/features/gitMemory/gitMemoryService.test.ts test/app/memory/memoryTool.test.ts
```

## T05 — 知识自动注入的三路适用性限制（R4）

**依赖：**T01、T02。

**主要文件：**

- `packages/agent-core-v2/src/agent/knowledge/sqliteKnowledge.ts`
- `packages/agent-core-v2/src/agent/knowledge/knowledge.ts`
- `packages/agent-core-v2/src/agent/knowledge/knowledgeService.ts`
- `packages/agent-core-v2/src/agent/knowledge/knowledgeInjection.ts`
- `packages/agent-core-v2/test/agent/knowledge/sqliteKnowledge.test.ts`
- `packages/agent-core-v2/test/agent/knowledge/knowledgeInjection.test.ts`
- `packages/agent-core-v2/test/agent/knowledge/knowledgeLoop.test.ts`

**动作：**

- 将主动 search 与自动 searchForInjection 分开；更新 injection 的会话路径输入。
- SQLite 注册同一纯路径谓词，scope/FTS/tag SQL 都在 LIMIT 前限制适用范围。
- 保留 confidence gate、既有排序权重和手动搜索行为。

**必须通过的断言：**

- 用关键词、标签分别匹配 B 的条目，A 的自动输出均不包含 B。
- 生成 30 条 B 高相关记录加 1 条 A 合法记录，A 仍被召回，不被错误 over-fetch/后置过滤挤掉。
- 无文件线索不注入子目录规则；全局/项目根规则照常可用。
- 主动搜索仍可查到既有宽范围内容，未确认低置信度记录仍不能自动注入。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/agent/knowledge
```

## T06 — 去重归属与上下文失效（R5）

**主要文件：**

- 新增 `packages/agent-core-v2/src/agent/injection/memoryInjectionState.ts`
- `packages/agent-core-v2/src/agent/injection/renderedLines.ts`
- `packages/agent-core-v2/src/features/gitMemory/gitMemoryEntries.ts`
- `packages/agent-core-v2/src/features/gitMemory/gitMemoryService.ts`
- `packages/agent-core-v2/src/features/associativeMemory/service.ts`
- `packages/agent-core-v2/src/features/associativeMemory/render.ts`
- 对应的 renderedLines、associative service/injectionWindow、GitMemoryService、fullCompaction 测试

**动作：**

- 用 Agent scope 状态替换 session 级全局集合，复用前缀 revision 检测重写。
- Git 的本地路径/commit/正文状态与新的 generation 一起失效。
- 渲染器报告真正包含的项目，返回后才 mark；未发送项目不消耗注入机会。
- 覆盖真实 clear/compaction/fork/restore 链路；若需额外事件失效，只影响注入状态。

**必须通过的断言：**

- 相同 session 的两个独立 agent 均能首次注入；同一 agent 普通追加不重复注入。
- agent clear 或 compaction 之后同一条合法记忆能重新出现；另一个 agent 状态不受影响。
- Git 路径先前命中过，压缩后再次读取仍返回所需记忆，不被本地 hasPath/hasMemory 挡住。
- 渲染上限排除某条尾项后，后续有空间时它仍能被注入。
- 释放 agent 释放去重集合；既有缓存探针的 prefixRevision 测试不变红。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/agent/injection/renderedLines.test.ts test/features/associativeMemory/injectionWindow.test.ts test/features/associativeMemory/service.test.ts test/features/gitMemory/gitMemoryService.test.ts test/agent/fullCompaction/fullCompaction.test.ts
```

## T07 — 成功 HEAD 缓存刷新与乱序保护（R6）

**主要文件：**

- `packages/agent-core-v2/src/features/gitMemory/gitMemoryIndexLoader.ts`
- `packages/agent-core-v2/src/features/gitMemory/gitMemoryService.ts`
- `packages/agent-core-v2/src/features/gitMemory/projection.ts`
- `packages/agent-core-v2/src/features/gitMemory/gitMemoryRenderState.ts`
- `packages/agent-core-v2/src/agent/profile/profileService.ts`（只在初始 snapshot 身份需要时）
- `packages/agent-core-v2/test/features/gitMemory/gitMemoryIndexLoader.test.ts`
- `packages/agent-core-v2/test/features/gitMemory/gitMemoryService.test.ts`
- `packages/agent-core-v2/test/features/gitMemory/projection.test.ts`

**动作：**

- 新回合强制 HEAD 检查；普通入口成功检查 2 秒复用；使用 fake clock，测试不 sleep。
- loader 使用 session cwd；HEAD/index 身份变动时清缓存。
- 为异步 rebuild 发布增加 generation/目标检查和 single-flight。
- 新回合 reminder 标识新仓库快照；降级时明确 snapshot 与 observed HEAD。

**必须通过的断言：**

- HEAD A 成功加载后换 B，即便不足 2 秒，新回合也取得 B；无新回合时 2 秒到期后下一入口取得 B。
- 同回合连续 10 次 fileBlock 不产生 10 次 HEAD 子进程；两个并发检查只启动一个对应检查。
- 先发 A rebuild，后发 B 并先完成 B，再完成 A，最终只能发布 B。
- HEAD 失败保持原有 cooldown；损坏缓存重建不回归；旧快照降级不会标成新 HEAD。
- session cwd 和 app cwd 不同时，仓库与文件前缀从 session 解析。
- 不靠完整 profile 重建使更新生效；新回合 reminder 能观察当前 HEAD。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/features/gitMemory
```

## T08 — 热/冷工作集完整实现（R7）

**依赖：**先完成 T03 的 store 迁移协作与 T06 的注入行为。

**主要文件：**

- `packages/agent-core-v2/src/features/associativeMemory/store.ts`
- `packages/agent-core-v2/src/features/associativeMemory/service.ts`
- `packages/agent-core-v2/src/features/associativeMemory/types.ts`
- 新增内部 hot-index 协作对象（仅在 store 单文件无法清晰承载时，职责限定为热清单/计数恢复）
- 现有 eviction、durability、migration、contentRetention、maintenance、service、scopeIsolation 测试及新工作集回归

**T08a — 磁盘模式与规范访问：**

- 用 disk mode 打开相同 canonical keys，加入热清单、计数和按 ID 的冷读取。
- 旧清单缺失时用每页 256 条扫描重建；正常启动只装热清单。
- 复用 MiniDb.batch 原子更新状态/清单/计数；持久化失败不先让 Map 暴露成功。
- 冷读取用 note/span 重建完整 text，不隐式加入常驻 Map。

**T08b — 逐个更新所有冷热消费者：**

- default recall/train/maintain、history recall、list、stats、export、rebuild。
- pin、forget、reconsolidate、重复检测、旧源迁移的完成标记。
- 移除旧“全量 Map 即全部数据”的假设，清理不再使用的旧 helper；不能留下默认新/隐藏旧两个读路径。

**T08c — 兼容与规模验收：**

- 旧 memory-mode fixture（含 compacted generation、snapshot/WAL）以 disk mode 打开，再关闭重开；规范数据不能丢失。
- 继续验证同一数据以原 memory mode 可重开读取，以确定底层格式未被无说明破坏。
- 合成 atomBudget=2/noteBudget=2，历史 20、200、2000 三个规模；维护后非 pin 活跃为 2，常驻正文/向量集符合设计界限，不能随历史升至 20/200/2000。
- default recall 的 store spy 在预热后拒绝全历史正文扫描，但召回仍正确；history recall 找得到被淘汰项。
- list/stats/export 包含同一完整历史集合；export ID、正文、来源和计数无遗漏，rebuild 后显式忘记项不复活。
- pin 数量超出普通预算时不丢 pin，计数明确反映例外；不以删除历史使测试变绿。
- disk value mode 和 Map 数量为确定性指标；RSS/耗时仅记录为辅助测量，不用脆弱的毫秒断言作为唯一验收。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/features/associativeMemory
```

如果必须修改 MiniDb 本身而非仅使用其接口，先增加 owning 包的最小复现，再串行运行：

```bash
# cwd: packages/minidb
bun test --isolate test/db.test.ts test/recovery.test.ts test/generation.test.ts
```

在 T08a/b/c 全部完成前，不能把“活跃数量已限制”或“换成 disk mode”单独当成 R7 完成。

## T09 — 串联真实服务的合成端到端验收

**依赖：**T01–T08。

**主要位置：**扩展现有 core harness 与 associativeMemory integration 测试；涉及真实 Git 的场景采用现有 git fixture，无网络。

**场景顺序：**

1. 在隔离临时根创建 A/B 仓库、各自 knowledge DB、global/project/session 源记录。
2. 同进程启动 A/B agent，交错写读，验证数据库与自动投影不串。
3. 触发懒迁移，关闭重开，验证 scope 与持久幂等。
4. 同 session 再创建独立 agent 和真实 fork；验证每份实际上下文得到所需记忆，而非仅检查共享 Map。
5. 执行实际 clear/compaction 再请求，检查模型请求中的重新注入。
6. 创建本地新 commit/切分支，通过新回合请求检查仓库快照刷新。
7. 制造容量压力，再 history/list/stats/export/rebuild，关闭重开后重复关键断言。

**验收：**

- 请求捕获使用本地 mock requester，不接真实模型端点；断言不含 B/旧 session 标记，包含各自合法标记。
- 分别覆盖 git/associative 关闭、单独开启、共同开启；不是靠关闭功能或 mock 掉过滤方法通过。
- 迁移、数据库 handle、去重、HEAD 的生产协作对象参与调用，不用只调纯函数的测试代替整条链路。
- 全部临时目录、连接、后台进程在 teardown 清理；没有新增的私人库访问。

**命令：**

```bash
# cwd: packages/agent-core-v2
bun test --isolate test/features/associativeMemory/integration.test.ts test/agent/knowledge/knowledgeLoop.test.ts test/features/gitMemory/gitMemoryService.test.ts test/agent/fullCompaction/fullCompaction.test.ts
```

## T10 — 文档、兼容消费者及最终交付

**依赖：**所有功能任务通过。

**动作：**

- 自审完整本任务 diff，核对 R1–R7、所有实际调用者和旧 helper 删除情况。
- 依据项目 gen-docs/translate-docs 指导更新既有中英文工具与功能文档：自动/主动范围差别、快照新鲜度、迁移边界、历史保留和容量例外。
- 按 gen-changesets 规则处理用户可感知变更，不自行改 package version，不发布。
- 只有公共接口/manifest 真实受影响才用现有 generator 更新，并检查不覆盖共享工作区其他任务的差异。
- 检查 git status 的新增文件，回收本任务临时残留；不删除来源不明或其他任务的文件。

**验证阶梯：**先执行前面每个阶段的最小测试；实现完成后再各运行一次下面相关集合。若后续为修复而修改了代码，重跑覆盖该修改的检查；不机械重复全仓检查。

```bash
# cwd: packages/agent-core-v2
bun run typecheck
bun run test
bun run build
```

由于保留了根 knowledgeClose 清理契约以及 engine 服务组合，消费者补充验证为：

```bash
# cwd: packages/kap-server
bun test --isolate test/prompts.test.ts
bun run typecheck

# cwd: packages/node-sdk
bun test --isolate test/session-context.test.ts
bun run typecheck
```

从仓库根运行现有相关 gate，而不是另写脚本重实现：

```bash
bun run check:boundaries
bun run check:deep-imports
bun run check:no-comments
bun run check:git-memory
bun run check:service-naming
bun run scan:residue
bun run check:locale-keys
bun run check:locale-placeholders
bun run check:t-coverage
```

只有新增可见文案时再补 `check:no-hardcoded-prose`；只有改了 prompts/ownership 文档时补 `check:prompt-ownership`。不默认运行仓库根全套测试；本次若确实新增消费者契约，按实际受影响包扩大并记录理由。

**最终完成条件：**

- R1–R7 均有实现与当前版本的通过证据，不能用旧审查的 294 pass 代替。
- T09 场景端到端通过；所有本次相关检查无未解释失败。
- 旧数据兼容、实验开关默认值、主动搜索能力、历史/忘记语义均保留。
- 本任务没有遗留临时文件、连接、进程和非本任务差异；有其他客户端并行变更时明确报告，不接管。
- 最终中文报告给出逐项结果、关键代码位置、实际测试数字/命令，以及真实的剩余限制。若相关任务仍被阻塞，则保持未完成状态，不宣称全部完成。

## 需求覆盖索引

| 需求 | 主任务 | 集成/兼容验收 |
| --- | --- | --- |
| R1 数据库实例 | T01 | T09、T10 |
| R2 按归属迁移 | T02、T03 | T08、T09 |
| R3 Git 自动范围 | T02、T04 | T06、T09 |
| R4 知识规则范围 | T02、T05 | T09 |
| R5 去重生命周期 | T06 | T09、T10 |
| R6 Git 缓存新鲜度 | T07 | T09 |
| R7 历史/工作集 | T08a–c | T09、T10 |

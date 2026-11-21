# 实施记录 — specs/lockjaw-patriot-kate-bishop/tasks.md

## 授权与边界

- 三份规格已通过 ExitSpecMode；开始当前会话内串行实施。
- Ruling: 使用已批准的 tasks.md 作为唯一执行计划，不另建 docs/superpowers 计划或第二份 ledger；在当前共享工作区定点修改，不创建工作树、不提交、不推送。原因是用户要求按已批准清单推进且工作区含其他客户端的在途修改；若判断错误，风险是共享文件发生冲突，因此每次触及共享文件前须重新核实其现状。
- 执行技能可用；额外 TDD 技能加载被 maximum depth=3 限制拒绝，未绕过该限制，继续执行清单明确规定的 RED→GREEN 流程。

## 前置核对

- T00: complete。已再次查看 git status 和 TaskList，当前无后台任务/测试。记忆主体模块无已有修改；src/index.ts、profileService.ts、fullCompaction.test.ts、SDK/kap 及 UI 等有前序/并行差异，必须保留。
- 已读取现有 knowledgeLoop 测试、harness 入口与 options；沿用 createTestAgent 和完整临时目录路径，不使用空 bootstrap 对象。
- 前一轮 294 pass 仅作审查基线，不算本次实现验收。

## 接口预检

- T01→T05：实例数据库保留 schema/CRUD，由后续自动注入模式添加 WHERE 过滤；不能重新引入模块级 current DB。
- T02→T03/T04/T05：共享 helper 只判定作用域，不改变主动搜索；迁移和投影使用同一身份输入。
- T03→T08：迁移 ledger 使用 MiniDb meta namespace，冷热模式必须保留并恢复这些标记。
- T06→T07：上下文重写和 HEAD 改变分别使渲染状态失效，不能只清一层。
- T08→T09：只有热工作集可被默认召回读取，历史操作仍从同一规范记录取得全部数据。

## 当前状态

- T01: complete（实现与 owning 局部验收）。三个新服务回归先运行得到 5 pass / 3 fail，失败分别为串库、失败切库后原记录不可读、close-all 后句柄失效。实例化后服务回归 8 pass，再补路径/读取覆盖后 `bun test --isolate test/agent/knowledge` 为 41 pass / 0 fail（3 files，515 assertions）；`bun run typecheck` 通过。本地 oxfmt 已限定格式化本任务四个文件。消费者兼容检查留在 T10，不宣称最终整体验收已完成。
- T02: complete。新增 memoryVisibility.test.ts，缺失模块时先得到预期 RED；实现复用现有 paths.ts / projectIdentity 后，`bun test --isolate test/app/memory` 为 59 pass / 0 fail（6 files，133 assertions），包含旧项目身份与原 Memory 工具回归。
- T03: complete（实现与 owning 局部验收）。真实服务回归先得到 3 pass / 3 fail，三个失败为跨范围内容、失败后不重试、变化指纹不导入；修复后 migration 6 pass。另加入 note 写入、training 完成、complete marker 三处失败恢复，以及规则失败重试、真实关闭重开持久状态测试。最终 `bun test --isolate test/features/associativeMemory/migration.test.ts test/features/associativeMemory/legacyMemoryMigration.test.ts test/features/associativeMemory/scopeIsolation.test.ts test/features/associativeMemory/service.test.ts test/app/memory/memoryStore.test.ts test/app/memory/memoryTool.test.ts` 为 67 pass / 0 fail（6 files，212 assertions），引擎 typecheck 通过。旧源不再被全局冻结；原目录迁移仅考虑当前 cwd 的已知别名，失败不创建空目标覆盖。
- T04: complete（实现与局部验收）。repoBlock、fileBlock、revision/applies_to 三项先得到 45 pass / 3 fail；共享 visibility 和入口缓存同步后，`bun test --isolate test/features/gitMemory/gitMemoryService.test.ts test/app/memory/memoryTool.test.ts` 为 58 pass / 0 fail（2 files，156 assertions），主动 Memory 操作回归保持通过。
- T05: complete（实现与局部验收）。两个新增回归先失败于自动入口缺失；补强 FTS LIMIT 用例，排除 scope lane 掩盖。自动三路查询复用 SQLite 路径谓词，在 LIMIT 前过滤，保留主动宽范围 search。`bun test --isolate test/agent/knowledge` 为 43 pass / 0 fail（3 files，522 assertions）；引擎 typecheck 通过。
- T06: complete（实现与局部验收）。Agent-scoped bounded dedupe state 绑定 context prefixRevision；clear/compaction/fork/restore 更新 generation，append 不清空。Git 的 path/commit/memory/applies_to 本地状态按 generation 清理；Associative render 返回真正包含的 RecallItem 并只标记/触碰实际渲染项。真实 clear/compaction、多 Agent 与 token 截断回归通过。`bun test --isolate test/features/gitMemory/gitMemoryService.test.ts test/features/associativeMemory/injectionWindow.test.ts test/agent/injection/renderedLines.test.ts test/features/associativeMemory/render.test.ts` 为 67 pass / 0 fail（4 files，169 assertions）。
- T07: complete（实现与局部验收）。成功 HEAD 2 秒复用、新回合强制检查、失败 cooldown、并发 single-flight、A/B 乱序发布、目标 SHA 固定读取与串行 guarded cache write 已接入；新回合无路径也检查并声明 snapshot/observed HEAD，初始 repoBlock 也包含快照身份。Git owning suite 最终 107 pass / 0 fail（7 files，268 assertions），引擎 typecheck 通过。最后 session cwd fixture 曾因 spawn options 遮蔽 harness options 误失败，修正变量名后通过。
- T08: complete（实现与 owning 回归）。MiniDb disk 模式、v3 热索引、分页规范读取与完整计数已接入；普通 recall/maintain 使用热图，显式 history/list/export/rebuild 跨冷热。20/200/2000 历史规模下预算 2/2 的正文/向量驻留不随历史增长；WAL/compacted generation 在 memory/disk 间互读、forget 后重建与重开、冷 note 去重、批次故障不发布 Map、关联度淘汰及审计均通过。自审补测复现并修正 pin 挤占普通预算、失败打开后实例不能重试；共享句柄按实际实例释放并等待旧关闭。列表同时间戳按 note/span 稳定排序，修复磁盘键排序导致段落倒序。最新 `bun test --isolate --timeout 30000 test/features/associativeMemory` 为 280 pass / 0 fail（40 files，859 assertions，7.46s）；包 typecheck 进行中，最终消费者验收仍待 T10。
- T09: complete。扩展原 integration.test.ts，使用临时 A/B Git 仓库、各自 SQLite、真实 MemoryStore/迁移 ledger/Git loader/Agent DI/requester 捕获完成四种开关组合、交错知识写读、global/project/session 隔离、关闭重开幂等、同 session 独立 Agent/真实 fork、实际 clear/full compaction、新 commit/分支 HEAD、容量压力后的 history/list/stats/export/forget/rebuild/reopen。请求链路发现检索 cue 会误读之前的 reminder，三路注入均改用既有 isRealUserInput；增加 reminder-only 规则不进入其他自动投影的回归。按 T09 命令运行四文件为 208 pass / 0 fail（9 snapshots，949 assertions，22.60s），包 typecheck 通过。随后增强容量用例断言为实际注入格式而非用户 prompt 本身，定向 1 pass / 0 fail（12 assertions）；没有使用真实模型端点或私人记忆。
- T10: complete。完成本任务源码/调用方/冷热消费者及双语文档自审；保留其他客户端差异，没有提交、推送、版本变更或系统 exe 部署。最终模块回归为 475 pass / 0 fail（52 files，1838 assertions，18.87s），覆盖最新 Windows 盘符及失败注入去重修复。核心 typecheck/build、受影响消费者、相关门禁与文档构建均已完成，整包并行回归中的超时及诊断结果如实单列如下。

## T10 自审补齐

- `memoryInjectionState.ts` 将隐式 getter 求值改为显式同步方法，`knowledgeClose()` 直接遍历活跃集合；修复 3 个 lint errors，未改变清空/压缩/跨 Agent 的语义。复验六文件 232 pass / 0 fail（9 snapshots，1035 assertions）。
- Windows 盘符由 Knowledge 文件线索扫描器保留。新增正反斜杠与 SQLite 实际注入回归先得到 11 pass / 3 fail，确认 `D:/work/repo/src/main.ts` 会被截成 `/work/repo/src/main.ts` 并错误套用 C 盘目录规则；修复后与 visibility 两文件 43 pass / 0 fail。
- 记忆持久化失败导致 signalBlock 返回空时，不提前认领正文去重。新增故障回归先得到 5 pass / 1 fail，将 claim 移至成功返回之前后为 6 pass / 0 fail。
- 更新既有 `docs/{en,zh}/reference/tools.md`，说明自动/主动范围、来源版本迁移、上下文和 HEAD 生命周期、冷热保留与例外；修正旧 changeset 的“全局只读”描述并增加 `.changeset/memory-scope-lifecycle.md`。没有改动模型提示词或实验默认值。

## 最终验证证据

以下命令均在标注目录执行，测试套件串行运行；后续小修只重跑受影响集合，不重复整包九千项测试。

### agent-core-v2

- `bun test --isolate --timeout 30000 test/agent/knowledge test/agent/injection/renderedLines.test.ts test/app/memory/memoryVisibility.test.ts test/features/associativeMemory test/features/gitMemory`：475 pass / 0 fail，52 files，1838 assertions；包含四种实验开关组合、真实 Agent/SQLite/MiniDb/Git 合成场景与本轮新增回归。
- `bun run typecheck && bun run build`：通过；最终 build 4688ms。构建仍报告 TypeScript 7 experimental、`bun:ffi` 被当作 external 和插件计时 warnings；这些不属于本任务修改，不将其描述为零警告构建。
- 之前按 T10 执行的 `bun run test`：原始并行池 9440 pass / 102 skip / 2 fail（两项 Plan 测试 30s timeout）。wrapper 对 errors、memoryTool、sessionManager、environmentRegistry、subagentScopeCache 五文件执行隔离诊断并报 FLAKY(contention)，脚本最终退出 0，但这不等于原始池无失败。
- 补足未被 wrapper 覆盖的 Plan 文件：`bun test --isolate --timeout 30000 test/features/plan/plan.test.ts`，30 pass / 0 fail，2 snapshots，117 assertions，3.17s。未更改 Plan 实现或超时，不把资源争用报告隐藏为全绿。

### 消费者与文档

- kap-server：`bun test --isolate --timeout 15000 test/prompts.test.ts`，76 pass / 1 skip / 0 fail，409 assertions；`bun run typecheck` 通过。
- node-sdk：`bun test --isolate --timeout 15000 test/session-context.test.ts`，8 pass / 0 fail，18 assertions；`bun run typecheck` 通过。
- docs：`bun run build` 通过，17.13s；本轮只修改既有中英文工具参考文档，没有 UI 变更。

### 根目录门禁

- 修改范围的 `oxlint --type-aware --quiet`：0 errors / 261 warnings，111 files；没有把全量 warnings 归零或修改规则。
- 本任务 41 个 TypeScript 文件的 `oxfmt --check`：通过。最初目录范围额外包含未修改的 `knowledge/tools/knowledge-tool.md`，该文件有既有格式问题；未为本次修复改写模型工具提示词。
- `bun run check:boundaries`：imports（2046 files）与 deep-imports 均通过。
- `bun run check:no-comments`：2370 files，通过。
- `bun run check:git-memory`：11 files，通过。
- `bun run check:service-naming`、`bun run scan:residue`：通过；residue 扫描 6010 files，0 errors，既有 warnings 保留。
- `bun run check:locale-keys && bun run check:locale-placeholders && bun run check:t-coverage`：通过。
- `git diff --check`：通过，只有既有换行规范化提示。

## 清理与交付边界

- 最终 TaskList 无活跃后台任务；未启动常驻服务，未添加一次性脚本或仓库内调试日志。最终 git status 的新增项均能对应本任务交付或初始已有的其他客户端工作，没有新增 memory-export.json、knowledge.db 或 undefined 路径残留。
- 合成库、Git 仓库、导出及连接由测试 fixture teardown 处理；未读取或迁移真实私人记忆。
- 保留共享构建输出目录：docs/.vitepress/dist 创建于本任务之前，core/dist 经标准构建重建，无法从当前状态恢复可靠的先前产物基线，未擅自删除共享输出；docs cache/.temp 不存在。
- 历史规范数据继续保留，常驻正文/向量热集有界，但 MiniDb 键/位置元数据和显式全历史查询临时内存仍可增长。不自动推断或清除无可靠来源的既有污染。
- 无剩余本规格实现项或需要用户决策的阻塞；并行测试争用、lint/build warnings 作为已观察到的验证限制保留。

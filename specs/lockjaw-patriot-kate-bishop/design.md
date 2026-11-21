# 多记忆模块修复设计

## 1. 推荐方案与取舍

采用“原模块渐进修复＋少量共享边界”的方案。数据库仍由知识库模块负责；文本/Git/联想记忆继续保留各自接口。共享内容只有项目/会话可见性与 agent 级注入去重，不创建总记忆总线、不替换检索算法。

比较过的方案：

1. **原模块修复（采用）**：直接解决七项已复现问题；可按责任逐批验收，保留旧数据和工具能力。
2. 只在输出前增加过滤：改动少，但无法修复数据库串写、迁移持久污染、候选名额被其他范围条目抢占和缓存生命周期，不满足需求。
3. 统一数据库和全部记忆 API：潜在长期一致性较好，但扩大迁移及兼容风险，也不是本次七项修复的必要条件，不采用。

本规格无须用户再选择底层数据库或缓存算法；上述第一项是完整实施路径。范围、默认决策见 [requirements.md](requirements.md)。

## 2. 当前链路与变更边界

- `app/memory/memoryStore.ts` 为应用级 Markdown 索引；`memoryRepo.ts` 为其提交提供来源。主动 Memory 工具支持跨项目检索，这是保留的能力。
- `features/gitMemory/gitMemoryEntries.ts` 把该索引投影到自动记忆，目前只匹配 applies_to，没有检查归属。
- `agent/knowledge/knowledgeService.ts` 是 agent 级服务，但 `sqliteKnowledge.ts` 的连接是模块单例；自动注入位于 `knowledgeInjection.ts`。
- `features/associativeMemory/service.ts` 同时承担迁移、训练、召回和维护；本次只抽出迁移协作对象，不做无关文件拆分。
- `agent/injection/renderedLines.ts` 当前按 session 使用进程级 Map；Git 和联想记忆共同消费。
- `GitMemoryIndexLoader` 缓存 HEAD 与索引；`profileService.ts:988` 只在构建系统提示上下文时取得 repoBlock，因此刷新不能仅改 loader 后就宣称现有提示也自动变化。
- `AssociativeMemoryStore` 使用 MiniDb memory mode 又维护完整 Map，历史正文/向量有两层常驻副本。MiniDb 已支持 disk mode、按键读、带界限 scan、原子 batch 和 generation 恢复，应直接复用。

主要新增内部文件预计为：

- `src/app/memory/memoryVisibility.ts`：纯作用域/路径身份判断。
- `src/features/associativeMemory/legacyMemoryMigration.ts`：可恢复的记录级迁移。
- `src/agent/injection/memoryInjectionState.ts`：agent 级注入状态。

其余修改落回已有 owning 模块及对应测试；新辅助类型不默认扩大 SDK/REST 表面。

## 3. 统一可见范围，保留主动搜索

### 3.1 长期记忆可见性

`memoryVisibility.ts` 定义不可变的 `MemoryVisibilityContext`，包含当前规范化项目 ID、由当前 cwd 计算的已知旧 ID 集合、当前 session ID。项目身份复用 `projectIdentity.ts`，不再实现另一套远端/路径哈希。

判断流程：

1. 用 `parseMemoryPath` 解析路径；不识别的命名空间不注入。
2. 有条目 metadata 时，要求 metadata 的 scope/scopeId 与路径一致；不一致不猜测归属。
3. global 可见；project 只有 canonical/当前已知别名可见；session 仅精确匹配当前 session。
4. 项目/会话边界满足后，Git 投影才匹配 applies_to。

Git 的 entriesCache 只保存当前可见记录。索引 revision、会话身份或上下文注入版本变化时失效对应缓存，不把其他项目正文装入投影缓存。

### 3.2 知识规则路径适用性

提供一个纯路径判定函数 `knowledgeScopeApplies(storedScope, projectRoot, requestedPath)`，由同一模块持有路径边界规则：

- null/空 scope 为全局规则。
- 相对 scope 以当前项目根解析；相对文件线索也以当前项目根解析。
- 绝对 scope 保持绝对含义，不把另一个项目的绝对路径重新解释成当前路径。
- 规范化点路径与目录分隔符。Windows 驱动器/UNC 路径按 Windows 大小写语义比较，POSIX 路径不全局转小写。
- 精确相同或 `scope + '/'` 的后代才适用，拒绝 repo/repo-old 的前缀误匹配。
- 没有文件线索时以项目根作为 requestedPath，因此子目录规则不会被猜中。

保留 `search()` 为主动搜索入口，增加内部 `searchForInjection()` 区分自动注入。`KnowledgeInjection` 改走后者，现有 Knowledge 工具仍走 search。

SQLite 连接注册 `knowledge_scope_applies` 标量函数，内部调用上述纯判定函数；已核对本仓库 `bun-types/sqlite.d.ts` 提供 Database.function API。自动查询把该谓词加入 scope/FTS/tag 三条 SQL 的 WHERE，放在各自 LIMIT 之前。最终出口再次防御性校验，但不能只依靠这个后置过滤。所有用户值仍参数化，作用域规范化不改写用户原始条目正文或 ID。

## 4. 知识库连接实例化（R1）

### 4.1 所有权

将 `sqliteKnowledge.ts` 的 schema/CRUD 实现收敛到 `KnowledgeDatabase` 实例。每个实例包含 connection、path、closed 状态和查询方法；不存在“当前数据库”选择器。

`AgentKnowledgeService` 持有自己的 database 与目标路径，替换 `native` accessor 和独立 initialized 布尔值。由实际 handle 状态决定是否需要打开。通过 `ISessionContext.cwd` 选择默认项目数据库；环境覆盖和用户库 fallback 的优先级保持。

同一路径的两个 agent 可拥有独立 SQLite 连接；不为修复引入连接池。WAL 处理同一文件并发，打开/关闭 B 不关闭 A。

### 4.2 打开与失败

- 校验传入目标为非空路径；`:memory:` 作为测试用内存目标直接打开，不执行 dirname('.') 的目录准备。
- 只在写入/显式 open 允许创建；openExisting 先确认目标存在。
- 创建连接、初始化 schema/函数失败时关闭该候选连接。
- 显式切换时先成功打开候选再交换本实例 handle；两级候选都失败不触碰别的实例，保留本实例原有可用 handle 并输出失败诊断。
- 注册实例 dispose，正常关闭从活跃连接集合移除。

### 4.3 兼容接口

根导出 `knowledgeClose()` 保留，显式关闭当前进程登记的全部知识库连接，供既有测试/清理使用。它不参与选择数据库。各服务在下次操作时可从 handle.closed 检测并重新打开自己的目标，不被其他服务“切库”。

旧模块级 knowledgeOpen/Add/Search 等函数没有生产调用者（本轮检索结果为服务和单元测试），一并迁移到实例方法；不保留第二套 schema/CRUD 逻辑。`kap-server/test/prompts.test.ts` 的现有 cleanup 调用要纳入兼容测试。

## 5. 旧记忆的可恢复迁移（R2）

### 5.1 按需范围

将 importLegacyMemory 委托到 `LegacyMemoryMigration`。先枚举路径并使用可见性规则过滤，再 get 合法条目。A 不读取/导入 B 的条目正文；B 的源文件留待 B 访问时迁移。

目的地：

- global → 现有 global store。
- 当前项目/已确认旧身份别名 → 当前 canonical project store。
- 当前 session → 保留 session 隔离的内部 store key：`session-` 加 session ID 的稳定摘要。它不会与项目的十六进制 ID 或 global 冲突，也不把任意 session 字符串当文件路径。

`MemoryScopeSelector` 不新增对外 session 写入选项；已有 all 表示本 agent 可见的 project/global/当前 session，project/global 的精确语义不变。没有旧 session 内容时不为一次读取创建空 session store。

### 5.2 完成标记与幂等

为每个源路径计算 originKey，在目标 store 的 meta 命名空间记录：源 scope/scopeId/path、fingerprint、目标 noteId、migrationVersion 和完成状态。迁移 note ID 由 originKey 与 fingerprint 确定，不依赖随机 ULID。

同一目标 store 的迁移和图变更使用该共享 store handle 的串行任务队列，避免两个 agent 各有一条局部 queue 却同时导入。跨进程遵循现有 MiniDb 文件锁，不绕过锁。

顺序：

1. 读取当前源条目并确认原始归属/指纹。
2. 在确定的 destination 上执行现有写入规则。
3. 写入确定 ID 的 note，训练/补齐派生原子。
4. 确认规范记录与训练结果已成功持久化后写 complete 标记。
5. 内容版本变化时先完成新版本，再把旧导入版本退入历史；不修改源 Markdown。

未 complete 的记录重试时复用原 ID，补齐而非重复创建。显式忘记已导入记录不会因同一源指纹再次访问而被重新导入；源内容有新版本时才产生新的迁移版本。规则阻止、锁失败、持久化失败均不写 complete，保持可重试诊断。

### 5.3 取消全局冻结

移除“本 agent 导入一次就 memoryStore.setReadOnly(true)”的副作用。Memory 工具的实验开关 gating 仍是功能开启时的表面切换；普通关闭功能后旧工具应可使用。旧存储仍是保留的迁移来源，不因局部迁移失败或只处理一个项目就被冻结。

不尝试用内容相似度修复此前缺少来源的混合记录。自动污染修复不是本次升级的隐含数据操作。

## 6. Git 自动记忆投影（R3）

`GitMemoryEntries` 接收明确的 visibility 与 agent injection state。读取时使用第 3 节 helper，不依赖 `applies_to` 来模拟项目边界。保持 commit 来源、entry 数量限制和主动 Memory 工具行为。

更新 `entries()` 的 cache identity 为 memory revision＋可见范围 identity；写入发生后清理 path→applies_to 缓存，避免旧 scope pattern 继续生效。`repoBlock`、`fileBlock` 的实际调用场景均覆盖，而不是只测试纯过滤函数。

## 7. Agent 级注入状态（R5）

新增 Agent scope 的 `IAgentMemoryInjectionState`，由 DI 生命周期释放。

- 拥有 sessionId、agentId、当前 `contextMemory.prefixRevision()` 和至多 1024 条正文指纹。
- 普通消息追加不清空；前缀 revision 改变时先清空，再允许新的检查/标记。
- 提供当前 generation 供 GitMemoryService 判断其 GitMemoryRenderState 是否也需要 clear。
- 同一 agent 的 Git/联想投影共用状态，从而保留来源间去重；不同 agent 天然不共享集合。
- 不增加进程级 session Map，不改变 prefixRevision 给缓存探针等现有消费者的含义。

GitMemoryService 在 repo/file/signal 三个入口检查 generation；上下文重写后清空路径、commit、记忆 SHA 与 applies_to 等本地渲染状态。首次状态不从另一个 agent 继承。

渲染先生成“最终文本＋实际包含的项目”再 mark。`renderRecall` 的纯字符串 API可通过统一渲染实现保留包装，生产调用取得 includedItems，避免标记掉被 token 上限遗漏的尾项。Git 也只在确定返回该正文时认领指纹。

对清空、压缩、恢复与 undo 的实际事件路径补测试：若某种重写未体现在现有 prefixRevision，注入状态单独监听其已存在的上下文事件来失效，不为此改变全局 revision 契约。

## 8. Git 成功缓存的失效与发布（R6）

### 8.1 检查和身份

`GitMemoryIndexLoader` 使用 session cwd，而不是 bootstrap cwd；规范身份为 repoRoot＋HEAD SHA＋历史 window/index version。

新增成功检查时间，复用间隔 2 秒。每个新回合的 `signalBlock` 显式要求 HEAD 检查，不在提取不到文件名时提前退出。普通 file/repoMap 入口复用短间隔结果。并发检查使用 single-flight promise；失败冷却使用原有常量和分支。

HEAD 发生变化时增加 loader generation，失效旧 indexLoaded 与依赖它的渲染缓存。rebuild/scheduleRefresh 捕获身份和 generation，只在仍匹配当前目标时发布；晚到的 A 构建不能覆盖已选择的 B。

### 8.2 降级与提示词快照

允许短暂使用旧可用索引，但投影必须携带实际 snapshot HEAD 与观测 HEAD，不能把 A 的历史描述成 B。失败不覆盖最近成功数据，等待已有冷却后重试。

系统提示词里的初始 repoBlock 是快照，不为每次提交重建完整 profile。在新回合 reminder 中，若 HEAD 与上次已声明的快照不同，投影一段带当前 HEAD 的仓库更新，然后再追加用户文件线索的 signal。`profileService.ts` 的已有系统快照入口保留，只补齐 snapshot 身份表达和必要集成测试。

## 9. 在同一 MiniDb 中分离热/冷工作集（R7）

### 9.1 保留 canonical 数据

AssociativeMemoryStore 改用 `valueMode: 'disk'`。保留 `note:`、`atom:`、concept/edge/cooc/procedure 等既有键和 JSON 字段；不复制到第二个历史数据库，不删除历史规范记录。

只把活跃/被 pin 或活跃图确实引用的正文、向量装入服务 Map。历史 atom/note 使用 MiniDb.get/getAsync 按键重建，返回后不自动加入常驻热 Map。元数据/index 仍随总记录数量增长，这是明确保留的磁盘索引成本。

### 9.2 热清单和持久计数

在现有 MiniDb meta 命名空间维护热 atom ID 清单、热 note 引用及聚合计数，记录 hot-index version。更新 atom 状态、热清单、引用/计数时使用已有 `MiniDb.batch()` 同步提交；不能只有内存 Map 改了而磁盘状态没更新。

- 非 pin 活跃项维护现有 4000 上限；note 热集维护现有 8000 目标与必要引用/pin 例外。
- 对已删除/被淘汰项，从热 Map 与热引用清单移除，但 canonical 值不变；按原有历史语义可读取。
- 第一次打开旧库或 meta 校验失败时，按每页 256 个键的方式重建清单/计数，不用一次 query 把所有历史 JSON 留在数组中。
- 正常打开直接加载热清单；正常召回/训练/维护只访问热图，不每回合扫描历史正文。
- 单个原子的 text 仍用 noteId/span 从原始 note 重建，保证不把截断的历史片段当规范内容。

MiniDb 的 generation manifest 含 valueMode。旧 memory generation 以 disk 打开时必须通过现有 snapshot/WAL 恢复后重建兼容 generation；实施前用旧库 fixture 验证，不能将 mode mismatch 处理成清空重建。与 MiniDb 有关的变更优先止于调用配置/测试；若必须修库，单独纳入受影响包验证。

### 9.3 跨冷热 API

store 增加明确内部访问面：热图访问、按 ID 的规范记录读取、按页遍历全部规范记录、聚合计数。逐个更新 service 的使用者：

- recall(includeHistory=false)、训练、维护：只用热图，结果不受历史数量线性拖累。
- recall(includeHistory=true)：临时按需加载相关 store 的历史视图，沿用现有 activate 排名和 conflict 处理；结束后释放，不能持久缓存。允许与历史量相关的临时内存，不静默缩小召回范围。
- list：先按持久记录的既有排序/limit 选结果，不因不在热 Map 就丢条目。
- stats：从聚合计数返回完整历史/来源统计；不为计数加载全部正文。可添加内部 residentCounts 供确定性测试，不默认扩大公共 stats wire。
- export：包含全部冷热记录，保持现有字段/返回计数；采用按页读取和增量输出避免导出数组再次常驻。
- rebuild：显式从全部规范 notes 按页重建派生图并重做热清单，保留删除/忘记状态，不能把已忘记记录重新当新事实训练。
- pin/forget/reconsolidate：按 ID 可定位冷记录；写回状态、计数、热清单保持一致。pin 不隐式取消 suppressed/删除状态。
- 重复检测：增加可重建的持久 fingerprint 索引，按原始 note 内容校验匹配；冷 note 不因不在 Map 而被重复写入或自动复活。

保留全部历史的磁盘增长是 canonical retention，不设置隐式 TTL。明确不以“总原子数量下降”为优化验收；验收的是正文/向量常驻工作集及默认召回读取量。

## 10. 兼容性、测试和交付

- 旧 SQLite schema/数据不变；主动 search、Knowledge 工具和根 knowledgeClose 导出有专门兼容测试。
- 旧 Markdown 不删不改；迁移 metadata 是新增派生记录，保留身份映射。
- 旧联想 MiniDb canonical keys 不变，disk/memory reopen 和 generation 恢复做双向可读验证；关闭后重开必须保留相同历史 ID、正文、来源和忘记状态。
- 各实验开关关闭/单独开启/同时开启都测，确保不是依靠禁用功能通过测试。
- 测试使用现有 harness、fixture 与测试文件；没有匹配 owner 文件时才增加聚焦的新测试文件，不创建一次性审查脚本。
- 相关文档更新现有中英文工具/功能说明；公共接口或 manifest 真有变化时才运行已有 generator，保留其他任务差异。
- 测试阶梯及每阶段精确验收见 [tasks.md](tasks.md)。实施后才创建本目录 progress.md，记录实际结果；规格阶段不伪造进度。

## 11. 风险与停止条件

- 已污染但无 origin 的用户记录不能自动可靠分离：报告这项边界，不能猜测后写入真实库。
- 某个兼容性或数据恢复用例失败：继续修复该项，不能以“其余测试全绿”跳过；若需用户决定不可逆数据操作，保持相关阶段未完成并请求明确授权。
- 历史数据集造成的元数据成本与显式全历史查询峰值仍存在；不虚报为完全恒定内存。
- 不为增加信心重复整仓回归；只在接口/公共契约确实触及消费者时扩大验证，未通过的相关检查必须保留为阻塞。

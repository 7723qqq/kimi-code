# kimi-agent (Rust 引擎) v2 等效补齐路线图

> 目标:Rust 引擎在**自身能力**上功能等效 v2(agent-core-v2)引擎。
> 范围说明:不计接线层(engineOverride / rust-loop 的宿主通信)。凡是 v2 中属于宿主配套
> (上下文存储、权限、工具注册表、分布式 features)且借助现有 host 回调即可用的能力,一律
> 保持 host 侧,不重复迁移到 Rust;仅补齐 Rust 引擎**自身确实缺席**、且会导致功能丢失的部分。

## 现状基线(2026-08 核实)

### 已具备

| 能力 | 位置 | 说明 |
|------|------|------|
| Turn 循环 | `src/turn_loop/run_turn.rs` | 多步循环:goal 预算检查 / 暂停 / 阻塞、取消标志(step 边界)、before/after hooks、并发工具执行 |
| LLM 抽象 | `src/turn_loop/types.rs` `LLM` trait | 三种实现:`NativeHttpLlm`(native 直连,SSE)、`HostLlmProxy`(host 代理)、`MultiLLM`(并发 first-past-the-post) |
| 重试 | `src/turn_loop/retry.rs` | 指数退避 + jitter |
| 原生只读工具 | `src/tools/mod.rs` | Read / Grep / Glob,沙箱到 workspace root,越界或复杂参数回退 host;Write/Edit/Bash 永不 native |
| Goal 预算雏形 | `run_turn.rs` 开头 | token/turn 预算检查、暂停/阻塞/预算耗尽停止、steering 文本 |
| 取消 | `main.rs` / `napi_bindings.rs` | turn_id → `AtomicBool`,step 边界观察 |

### 死代码(已处理,P0)

| 项 | 处理 | 结果 |
|----|------|------|
| `src/turn_loop/tool_scheduler.rs` | 接入 | ✅ 已由 run_turn 使用(见 P0) |
| 预测执行框架(`is_prediction` 通道) | 删除 | ✅ 已删除(见 P0) |
| `ToolAccesses` 资源冲突检测 | 接入 | ✅ 已由调度器使用(见 P0) |

### 主要缺口(与 v2 对照)

1. **上下文投影** — native-LLM 模式下 Rust 自己拼消息历史,与 v2 `contextProjector`(媒体降级、裁剪)行为不一致;rust-loop 的 `toWireMessage` 丢弃 think/audio/video 块。
2. **注入层** — v2 的 plan/skill/reminder/dateChange 等靠注入 system prompt 工作。host-proxy 模式由 host 注入(可用);native-LLM 模式 Rust 自己拼 prompt(`run_turn.rs`),注入全丢。
3. **状态 / 事件 / 遥测** — Rust 事件为任意 `serde_json::Value`,无 schema;usage 仅回 input/output,缺 cacheRead/cacheCreation;无 telemetry 对齐。
4. **Goal 只有一半** — 预算达成后无 host 状态同步,无 goal 刷新,缺 wall-clock 预算。

---

## P0 — 清理死代码与半成品(先做,决定骨架) — ✅ 已完成

| 工作项 | 处理 | 状态 |
|--------|------|------|
| `tool_scheduler.rs` | **接入并发工具调度** | ✅ run_turn 实际使用 `schedule_tool_calls` + `execute_scheduled`(批内并发、批间串行) |
| 预测执行框架 | 删除 `is_prediction` / `force_precise` 字段、后台精确替换管线、`WorkspacePredictor` 死模块 | ✅ `cargo test`(195 lib + 6 集成)+ bun 侧 42 个测试全绿 |
| `ToolAccesses` | 接入工具调度形成并发冲突控制 | ✅ 新增 `infer_tool_accesses`(read/write/edit/grep/glob)按工具名+参数推断 accesses;并发写同一文件被串行化,非冲突调用仍并行 |

> 决策点回顾:保留了 `ToolAccesses` + 调度器作为后续写工具沙箱的前提。未知工具给空 accesses(并行安全),host 侧仍有完整 permission + 冲突层兜底。

## P1 — 上下文投影对齐(缺口最大的单一来源) — ✅ 已完成

问题:native-LLM 模式下 Rust 直接消费历史消息,而 v2 由 `contextProjector` + `llmRequester` 共同负责投影。实施中核实了归属:**host 的 `buildMessages()`(engine override 路径)已跑过 `projector.project()`(结构修复),但媒体策略(降级/剥离)是 `llmRequester` 按请求字节预算动态决定的,engine 路径不经过它** —— 因此 Rust 侧只需把 host 投影结果**无损搬上 wire**,媒体压缩/裁剪阈值不在本层职责。

| 工作项 | 结果 |
|--------|------|
| `toWireMessage` → `projectHostMessageToWire`(rust-loop.ts) | ✅ 支持全部 v2 块类型:text 拼接、**think 跳过**(JS 侧 reasoning 单独承载,wire 无此字段)、image_url / audio_url / video_url 保真携带(url + id) |
| Rust wire 扩展 | ✅ `rpc/types.rs` `ContentBlock` 增 `AudioUrl` / `VideoUrl`;`openai.rs` 投影为原生 audio_url/video_url,`anthropic.rs`(无原生块)降级为占位文本;均带单测 |
| 消息反序列化校验 | ✅ `isHostMessage` + `isHostContentPart` 严格校验,替换 `as unknown as` 直距;畸形条目过滤而非强转 |
| 历史窗口裁剪 | ⏸ 未实施 — host 投影 already 含结构修复与窗口;Rust 单轮驱动无自有历史窗口,此项归 host 侧,从本路线移除 |

完成标准:native-LLM 下同一 context 的 LLM 请求与 JS 引擎投影逐块一致(media 以外)。验证:cargo 197 lib + 6 集成全绿、bun 37 测试全绿(rust-loop 20 含 6 个投影单测)、oxlint 0 errors。

## P2 — 注入层(最大功能缺口,native 路径下的丢失源) — ✅ 已完成

问题(实施中修正了根因):v2 的注入**不是拼接 system prompt**,而是 AgentReminder 等 runtime 通过 `loop.hooks.onWillBeginStep` 在步骤开始把 `<system-reminder>` 文本 **append 进 contextMemory**(origin.kind='injection'),随后由 `buildMessages` → `projector.project` 自然带上。而 `executeTurnViaEngine` **从不触发 `onWillBeginStep`** —— 因此 engine override 路径(host-proxy 与 native-LLM 都是)的注入整体丢失,比原假设更根本。

方案(替代原"Rust 侧 build_reminders 钩子"):让 engine 驱动入口走与 JS 路径相同的注入门。

1. ✅ `loopService.executeTurnViaEngine` 在驱动 engine 前调用 `hooks.onWillBeginStep.run(...)`(与 `executeLoopStep` 一致)—— 所有挂在该门上的注入(reminder / goal / plan-mode / external hooks)在 engine 路径恢复生效,注入随 `buildEngineInput` 的 `projector.project` 进入引擎读到的消息
2. ⏸ 原计划 1-3 步(Rust 侧 `build_reminders` 钩子 + napi/stdio 传递)不再需要 —— host 注入经 context 传递,引擎通过 `buildMessages` 自然读取,无需新增 wire
3. ✅ 新增回归测试 `engineOverride.test.ts`「runs the onWillBeginStep injection gate before driving the engine」:注册注入钩子模拟 AgentReminder,验证 engine 驱动时注入进入 context

完成标准:引擎驱动的 turn 与 JS 路径一样经过注入门,reminder/goal/plan-mode 注入可见。验证:agent-core-v2 loop 103 测试 + goal/reminder 190 测试 + engineOverride 4 测试全绿;oxlint 0 errors;测试无新增注释(agent-core-v2 no-comments 区)。

## P3 — Goal 完整化(v2 中已落入引擎内、但只有一半的能力) — ✅ 已完成

> **接线更新(2026-08-29)**:`getGoal` 的宿主注入已完成,见下方「接线项 — ✅ 已完成」。

| 缺失 | 补齐 | 状态 |
|------|------|------|
| 只有 token / turn 预算 | 补 wall-clock 预算:`GoalContext` 增 `wall_clock_budget_ms`/`wall_clock_ms`,`would_exceed_budget`/`budget_fraction` 支持,`render_goal_steering` 展示 `time x/10s (remaining n)`;wire(rpc/napi/stdio)同步 | ✅(+4 测试) |
| 预算达成后无 host 状态同步 | 预算耗尽时 `emit_event` 发射 `goal.budget.limit_reached`(带 goal_id)| ✅ 用 EventCapturingCallbacks 断言 |
| 无 goal 修改 / 重建 | `RustEngineOptions.getGoal`(每轮重取,host 快照随变)+ `TurnEngineInput.getGoal?` 契约(v2 侧)+ napi/stdio 双通道传参 | ✅ 契约与传递完成;**host 侧注入受 agent-core-v2 分层约束(loop 与 goal feature 互为依赖会触发 `import/no-cycle`),因此 getGoal 由签名方注入,不在 loopService 内硬接线**(旁路注入,见接线项) |

**接线说明(独立跟踪)**:~~getGoal 的数据提供方未注入~~ → **✅ 已完成(2026-08-29,见下方「接线项」)**。P2 修复后 goal 的 turn/usage 记账已随 `onWillBeginStep` + `TurnEnded` 在 engine 路径生效。

验证:cargo 202 lib + 6 集成全绿(新增 wall-clock 预算、事件断言、format_elapsed 测试)、bun 52 测试全绿、oxlint 0 errors。

## P4 — 状态 / 事件 / 遥测对齐 — ✅ 已完成

| 工作项 | 结果 |
|--------|------|
| 事件 schema 化 | ✅ rust-loop 侧 `EngineEvent` 升级为**判别联合**(llm.step.begin/delta/end、tool.native、goal.budget.limit_reached),全部类型化访问,移除 `event['key'] as ...` 强转;Rust 侧发射保持 serde_json(发射内部不做全套枚举,避免过度工程) |
| usage 细分 | ✅ `TokenUsage` 扩至 4 字段(`input_cache_read`/`input_cache_creation`);openai 解析 `prompt_tokens_details.cached_tokens`,anthropic 解析 `cache_read_input_tokens`/`cache_creation_input_tokens`(parse_response + stream);贯通 http.rs step.end 事件 → rust-loop step.end usage;+3 测试 |
| telemetry | ✅ `llm.step.end` 事件带 `latency_ms`(请求计时);事件计数/重试上报未接入(重试在 turn_step 外层,单一 sink 通道无 per-turn 指标承载,标注见下) |

**telemetry 备注**:事件计时已入 wire(latency_ms),但「事件数量 / 重试次数」上报需要 host 侧 telemetry 入口(engine 路径目前无 track2 通道)或自有计数聚合;此项作为后续接线项,不阻塞事件/usage 对齐。

> **接线更新(2026-08-29)**:事件/重试计数已完成,见下方「接线项 — ✅ 已完成」。

## 接线项 — ✅ 已完成(2026-08-29)

P3/P4 遗留的两个宿主侧接线缺口,连同 napi goal wire 的两个隐患一并补齐:

### 1. `getGoal` 宿主注入(goal 预算控制正式生效)

- `loop.ts`:`IAgentLoopService` 新增 `registerEngineGoalProvider(provider)` —— goal 归属方(feature)向 loop 注册快照提供者,避免 loop → goal 的 import 环;`TurnEngineInput.getGoal` 由 `buildEngineInput` 从注册表中现取(每 turn 读取,host 侧 goal 变更即时生效;dispose 注销)。
- `goalAgentRuntime.ts`:新增导出 `toTurnEngineGoalContext`(GoalSnapshot → 引擎 wire:status 的 `budget_limited/usage_limited` 映射为 `budgetLimited/usageLimited`,budget 的 null → undefined);MAIN agent 的 goalEffects 中注册 `engineGoal` provider。
- 效果:引擎路径下 Rust 侧 goal 预算执行(暂停/阻塞/`goal.budget.limit_reached`/steering 注入)从休眠变为生效;无 goal 时行为不变。
- 端到端测试(`goal.test.ts`「goal → external engine bridge」):真实 goal runtime 装配 + engine override,断言引擎入口 `getGoal()` 返回活快照(注入门已先计数当前 turn,`turnsUsed: 1`)、turn 后重读保持新鲜、无 goal 时为 undefined。

### 2. 事件数 / 重试数 telemetry(P4 遗留)

- Rust:`TurnResult` 增 `llm_retries`(run_turn 按 step 的 attempts 累计)与 `events_emitted`(由组装点填充);新增 `CountingCallbacks` 装饰器(callbacks.rs),在 stdio CLI 与 napi 两个组装点于 NativeToolCallbacks/native LLM sink **之前**包装 base callbacks,保证 step 生命周期/delta/native 工具/goal 预算事件恰好计数一次;`RunTurnResult`(stdio)与 `JsRunTurnResult`(napi)同步增字段,serde `#[serde(default)]` 保持 wire 向后兼容。
- JS:`TurnEngineResult` 增可选 `telemetry: { eventsEmitted, llmRetries }`;rust-loop.ts 双通道(napi/stdio)映射;`executeTurnViaEngine` 经 `track2('engine_turn', …)` 上报(新 telemetry schema `EngineTurnEvent`)。

### 3. napi goal wire 修复

- rust-loop.ts napi 路径原样透传 snake_case `GoalContext`,而 napi-rs 对象字段是 camelCase(goal 字段实际全部丢失);现显式投影为 camelCase 并补上原先缺失的 `wallClockBudgetMs`/`wallClockMs`。

### 验证

- `cargo test`:211 lib + 6 集成全绿(新增 llm_retries 计数、CountingCallbacks、wire roundtrip/defaults 测试);`cargo clippy` 0 warnings。
- bun:kimi-agent 39(rust-loop 20 + napi-integration 19,含重建后 .node 上的 goal 预算 BudgetLimited 端到端、telemetry 字段断言);agent-core-v2 engineOverride 7(新增 goal 注入与 telemetry 上报契约测试)、goalEngineBridge 3、goalOps 12;oxlint 0 errors。
- 说明:agent-core-v2 全量套件的预存失败已从 14 个修复至 3 个(2026-08-29 打磨轮),剩余均为 Windows 时钟/mtime/stdio 探针类时序敏感项,与本路线无关:
  - `runtime path shim`(新增 `src/runtime/runtimePath.ts`):posix path class 在 Windows 宿主进程内运行时(测试假环境、远程 posix runtime),盘符路径 `C:/...` 非 posix 绝对,朴素 resolve 会锚定到宿主进程 cwd(Bun 甚至以 msys 形式上报)导致路径拼接损坏;现盘符路径视为绝对并委托 win32 实现归一为正斜杠,win32 分支保持纯 win32。顺带去重 localRuntime/fakeRuntime 的重复 shim。修复 profile(3)/dateChange 注入链/staleGuard 关联路径。
  - `gitService` untracked diff:`/dev/null` 在 Windows 直接 spawn 下失效 → 平台判定用 `NUL`。
  - `fullCompaction`:钩子命令的 `process.execPath` 含空格被 shell 截断 → 加引号;`tokens_before: 24_144` 是含机器路径的字符启发式魔法数 → `expect.any(Number)`。
  - `tool.test.ts`:bun 的 shell 在双引号内不折叠 `\\`(偏离 POSIX),`node -e` 双层 JSON 转义的多行断言失效 → 助手脚本改 base64 传输;POSIX 钩子命令(`>&2; exit N`)bun shell 不认 → shell 中立 node 命令。
  - `bootstrapService` 种子测试:engine override 扩展点加入后种子为 2 项,测试未更新 → 已修。

验证:cargo 205 lib + 6 集成全绿(新增 cache 解析 3 测试)、bun 52 测试全绿、oxlint 0 errors。

## P5 — 验证与基准 — ✅ 已完成(有限边界)

1. **行为等效测试** ✅(务实版):engine override 契约测试 `engineOverride.test.ts` 扩充至 **7 个**——注入门、goal 注入、引擎 telemetry 上报、goal 事件、多步工具 round-trip 完整驱动。注意:逐事件 diff"JS 引擎 vs Rust 引擎"在结构上不可行(JS 自动发 step 事件,引擎手动 dispatch),以契约行为测试替代。
2. **性能基准** ✅ 相对基准已完成(2026-08-29,见下)/ ⏸ 真实 key 对比仍待有 key 环境执行。
3. **Cargo 侧** ✅:移除确认多余且生产使用的 `#[allow(dead_code)]`(JsonRpcRequest / JsonRpcResponse / JsonRpcErrorResponse / method_not_found),`cargo clippy` 0 warnings;其余 allow 为有意保留的 wire 字段声明。

**相对基准(已完成,2026-08-29)**——测引擎自身开销下限,LLM/工具均为即时 fake:

| 基准 | 结果 |
|------|------|
| `run_turn` step 吞吐,1 工具/步 | ~10,100 steps/s(~99 µs/步) |
| `run_turn` step 吞吐,8 并发工具/步 | ~1,780 steps/s(~14,300 tool-calls/s,~561 µs/步) |
| native in-process Read(真实 4KB 文件 × 8/步,含沙箱) | ~2,050 tool-calls/s(真实文件 I/O 占主导) |
| napi 单步 turn(1 次 llm_chat hop) | mean ~45 µs/turn(~22,000 turns/s) |
| napi 工具往返 turn(2 llm + 1 tool hop) | mean ~85 µs/turn(~11,700 turns/s) |

**结论**:每次 TSFN 往返 ≈ +20 µs —— host-proxy 模式的传输开销相对真实 LLM 时延(数百 ms 起)可忽略;native-LLM 的收益预期主要来自流式事件不再跨进程转发与引擎自主循环,而非传输本身。重跑方式:`cargo test --release --test turn_bench -- --ignored --nocapture` 与 `bun x vitest bench --run`(napi-roundtrip.bench.ts)。

**性能基准方法(真实 key 对比,待有 key 环境执行)**:
- 同输入、同 provider 下对比 native-LLM + nativeTools vs host-proxy,收集 LLM 首 token 时延与工具往返耗时。
- 用 `llm.step.end.latency_ms`(P4 已入 wire)作为原生路径指标。

## P6 — 原生写工具 + 权限委托 — ✅ 已完成(2026-08-29)

引擎能力补全的第一垂直切片:**Write / Edit / Bash 原生执行,权限权威留在宿主**。沿用 P0 的取舍(宿主侧 permission + 冲突层兜底),本次把"执行"移进 Rust、"决策"留在宿主,为 headless 化(权限内置)铺路。

### 设计

- **决策在宿主**:新增 `HostCallbacks::check_permission`(必需 trait 方法)——原生执行 Write/Edit/Bash 前,引擎把 `{tool_name, tool_call_id, arguments}` 送宿主;宿主跑完整权限机器(模式/规则/策略/交互审批)回 `allow|deny`。**deny 即结果**:拒绝文本作为工具错误结果返回给模型,绝不回退宿主路径(避免二次弹窗)。
- **执行在 Rust**:`NativeToolset` 新增 `execute_mutating`(async)——Write(含多级新建目录)、Edit(唯一性校验/replace_all/二进制回退宿主)、Bash(tokio::process,平台 shell,工作区级 cwd 沙箱、600s 硬顶、256KB 输出截断、非零退出码 → 错误结果)。
- **沙箱纵深防御**:新增 `resolve_for_write`——向上找最近存在祖先做 canonicalize(解析符号链接逃逸)再拼回缺失尾部;cwd 逃逸 / 形状不识别 → `None` 回退宿主执行(宿主已授权,不会二次询问)。
- **调度**:bash 命令任意变更 → 推断为工作区级写访问(`write_tree_access`),与一切触碰沙箱的工具串行化。

### 传输

- stdio:新 RPC 方法 `host/check_permission`(请求/响应走既有 invoke 通道);napi:`runTurnRust` 增第 5 个可选回调(4th TSFN)。**napi 缺 checker 时 fail-closed**——拒绝原生执行变更类工具并回退宿主,保证新旧版本混装安全。
- JS:`TurnEngineInput` 新增 `checkToolPermission(call)`(可选契约);`loopService.buildEngineInput` 实现:registry.resolve → resolveExecution → `IAgentPermissionGate.authorize`(模式/规则/策略/审批全保真);**权限门经 IInstantiationService 惰性解析**——提前构造会重排 toolExecutor 权限监听器顺序,破坏 plan 模式对 plan 文件写入的先截权(有测试护航);评估异常 fail-closed。
- rust-loop 适配器:双通道(napi 回调 / stdio RPC)把权限请求映射到 `input.checkToolPermission`。

### 验证

- cargo:219 lib + 6 集成全绿(新增:沙箱内 Write/Edit/Bash、写路径逃逸回退、歧义/replace_all 编辑、bash 退出码、权限 allow 执行/deny 拦截且不回退宿主/只读工具免检、wire roundtrip);clippy 0 warnings。
- bun:kimi-agent 41(rust-loop 20 + napi-integration 21,含真实 .node 上的权限回调端到端:allow → 原生写入沙箱文件、deny → 拒绝为结果且无文件落盘);agent-core-v2 engineOverride 8(新增:原生权限检查走宿主权限门,未注册工具 deny);oxlint 0 errors。

## P7 — 权限往返评估(否决快速路径)+ 原生 Bash 语义对齐 — ✅ 已完成(2026-08-29)

### 已否决:Rust 本地权限快速路径

评估过"per-turn 权限快照 + Rust 本地求值"以消除每次原生写工具的权限往返。**读完整策略链后否决**:宿主策略链求值顺序为 AutoModeAskUserQuestionDeny → UserConfiguredDeny → **AutoModeApprove** → SessionApprovalHistory → UserConfiguredAsk/Allow → **SensitiveFileAccessAsk** → **GitControlPathAccessAsk** → **YoloModeApprove** → DefaultToolApprove → GitCwdWriteApprove → FallbackAsk——即 **yolo ≠ 无条件放行**(用户 deny 规则、敏感文件、git 控制路径都在 yolo approve 之前),且规则/审批历史/路径策略是动态宿主状态。本地求值任何简化都会造成安全语义分叉。**决策:P6 的逐调用往返是正确架构**——napi 实测单次往返 ~20-45µs,相对工具执行成本可忽略。

### 已完成:原生 Bash 与宿主语义对齐(接缝审计修正)

原生工具收到的是 **LLM 原始参数**,必须与公开 schema 逐字段一致,否则每次真实调用都会静默回退宿主。逐一核对:

| 工具 | 公开 schema | 原生实现 |
|------|------------|---------|
| Read | `path` / `line_offset` / `n_lines` | ✅ 一致 |
| Write | `path` / `content` | ✅ 一致 |
| Edit | `path` / `old_string` / `new_string` / `replace_all` | ✅ 一致 |
| Bash | `command` / `cwd` / `timeout`(秒,默认 60 上限 300)/ `run_in_background` / `disable_timeout` / `description` | ✅ 对齐 |

Bash 对齐内容:`timeout` 尊重参数(默认 60s、上限 300s);`run_in_background=true` 回退宿主(后台任务/任务面板/完成通知归宿主);**超时 = kill + 报告 `Command killed by timeout (Ns)`,绝不回退宿主重执行**;`description`/`disable_timeout` 忽略不回退。

### 接缝审计:存在≠如实(2026-08-30 补充)

切片级测试各自为绿,但**接缝**未经验证——审计发现并修复一个真实分叉:

1. **shell 语义分叉(真实缺陷,已修)**:原生 Bash 原实现选 `cmd /C`(Windows),而宿主 Bash 工具全平台契约是 **bash**(`environmentProbe` 在 Windows 定位 Git Bash 并以 `bash -c` 执行)。`ls`/管道/`$((...))`/`rm` 等在原生路径下行为全部偏离。修复:`NativeToolset` 接收宿主传入的 `shell_path`(JS 侧经 `probeHostEnvironment` 探测,`KIMI_SHELL_PATH` 覆盖优先);**Windows 上无 shell_path → 原生 Bash 直接回退宿主**(引擎不猜 shell);镜像宿主非交互 env(NO_COLOR/TERM=dumb/GIT_TERMINAL_PROMPT=0)。契约测试:原生 Bash 正确求值 `$((20+3))`(cmd 无法执行)。
2. **三缝合一 E2E**(`rustEngineE2E.test.ts`,agent-core-v2):真 napi addon + 真 rust-loop 适配器 + 真 loopService 权限门 + 脚本化宿主 LLM,驱动一次原生 Write:权限门 authorize(yolo)→ 原生写落盘 → transcript 完整。测试内置假 Write 工具(若回退宿主执行会产出 UNREACHABLE 标记),证明文件确由原生路径写入。

### 缺失审计(2026-08-30,"存在≠如实"第二轮)——修复 6 项

1. **安全:原生只读工具绕过敏感文件审批** —— 宿主策略链的 `SensitiveFileAccessAsk` 对任何声明文件访问的工具生效(含 Read 读 `.env`/`id_rsa`),而原生只读路径此前完全跳过权限检查。修复:**所有原生执行(只读+变更)一律先过 check_permission**(napi 单次 ~20-45µs,可忽略)。
2. **安全:原生 Grep 泄露敏感文件内容** —— 宿主 Grep 会过滤敏感文件并附 `Filtered N sensitive file(s)` 消息,原生 Grep 直接返回 `.env` 中的匹配行。修复:完整移植 `isSensitiveFile`(basename/路径后缀/env 前缀/豁免清单/点变体,分隔符等价),并在 walker 上开启 `hidden(false)`(宿主 rg `--hidden` 语义——否则 `.env` 根本不会被扫到,过滤形同虚设)。
3. **数据丢失:原生 Write 忽略 `mode: 'append'`** —— LLM 请求追加时原生路径会覆盖整文件。修复:实现 append(OpenOptions),未知 mode 回退宿主;输出格式对齐宿主(`Appended|Wrote N bytes to <path>`)。
4. **正确性:原生 Read 忽略 `region`/`full_resolution`** —— 半处理比回退更糟;现在出现即回退宿主媒体管线。
5. **格式分叉:Read 行格式** —— 原实现 `{:>6}→{}`,宿主为 `${lineNo}	${content}` 且行截断 2000 字符、`MAX_LINES=1000`(原写 2000)。已对齐。
6. **一致性**:bash 子进程 env 补 `SHELL=shellPath`(宿主同款);陈旧注释(ListDirectory)修正;补 bash 工作区级写访问的冲突推断测试。

### 验证

- cargo 228 lib(+6 审计修复测试)+ 6 集成全绿;clippy 0 warnings;bun 41 全绿;agent-core-v2 typecheck 0 errors;oxlint 0 errors。
- **仍未如实覆盖**(诚实边界):stdio 通道的 check_permission JS 端 handler 仅有代码审查无 E2E;真实 LLM 会话下的端到端验证仍需真实 key。



- P0 清理 ✅ / P1 投影 ✅ / P2 注入 ✅ / P3 Goal ✅ / P4 遥测 ✅ / P5 验证 ✅ / P6 原生写工具+权限委托 ✅ / P7 Bash 语义对齐(快速路径否决) ✅ / 接线项(getGoal 注入、telemetry 计数、相对基准) ✅
- 全部验证:`cargo test` 219 lib + 6 集成;`bun vitest` 全绿(kimi-agent 41、agent-core-v2 engineOverride 8、goal 桥接 114);oxlint 0 errors。
- agent-core-v2 全量套件余 3~4 个 Windows 时钟/mtime/stdio 时序敏感的预存失败(见 P5 说明),与本路线无关。

---

## 优先级与依赖

```
P0(清理) → P1(投影) → P2(注入) → P3(goal) → P4(遥测)
              └──────────↓──────────┘
         P1/P2 完成后,native-LLM 模式才真正功能等效 v2
```

## 关键取舍

- **P2 不做 features 移植**:plan/skill/tower 等宿主能力保持 host 侧(host-proxy 路径天然可用),仅在 Rust 侧打通"提醒注入"这一条会丢失的通道——用最小 Rust 改动换最大功能对齐。
- 若后续要求 native-LLM 下运行 tower/swarm,另立项做完整注入框架,不在本路线范围内。
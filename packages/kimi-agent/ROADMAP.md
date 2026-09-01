# kimi-agent (Rust 引擎) 替代 v2 路线图

> 目标:Rust 引擎**取代** agent-core-v2(下称 v2),v2 最终从仓库中删除。
> 功能等效只是迁移期的过渡态与验证手段,不是终点。判断进展的标准是「v2 侧被删掉了多少」,
> 不是「Rust 通过了多少 v2 的测试」。删除路线见文末 **P33**。
> 范围说明:接线层(engineOverride / rust-loop 的宿主通信)是过渡脚手架,必须带到期条件,不是架构。
> v2 中的宿主配套能力(上下文存储、权限、工具注册表、分布式 features)当前借 host 回调可用,
> 这是**临时状态**而非终态:每一项都需在 P33 中给出归属(Rust 吸收 / 明确保留并说明理由),
> 凡是判定由 Rust 吸收的,落地一项即删除 v2 侧对应实现,不允许两边长期并存。

## 现状基线(2026-08 核实)

### 已具备

| 能力 | 位置 | 说明 |
|------|------|------|
| Turn 循环 | `src/turn_loop/run_turn.rs` | 多步循环:goal 预算检查 / 暂停 / 阻塞、取消标志(step 边界)、before/after hooks、并发工具执行 |
| LLM 抽象 | `src/turn_loop/types.rs` `LLM` trait | 三种实现:`NativeHttpLlm`(native 直连,SSE)、`HostLlmProxy`(host 代理)、`MultiLLM`(并发 first-past-the-post) |
| 重试 | `src/turn_loop/retry.rs` | 指数退避 + jitter |
| 原生只读工具 | `src/tools/mod.rs` | Read / Grep / Glob / Write / Edit / Bash,沙箱到 workspace root,越界或复杂参数回退 host;只有这六个 native,其余仍走 `host/execute_tool` |
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

## P8 — 行为等效打磨(2026-08-30)

逐文件核实后发现 3 个与 v2 JS 引擎的真实行为分叉、若干死代码、1 个 ROADMAP 自认的 E2E 缺口,集中修复。

### 1. `maxSteps` 对齐 JS 语义

- 问题:Rust 两个通道都默认 `unwrap_or(10)`(`napi_bindings.rs:581`、`main.rs:73`),而 v2 JS 循环未配置 `maxStepsPerTurn` 时**无上限**(`loopService.ts:743-745`)。默认配置下 Rust 引擎 turn 会在 10 步后静默截断。
- 修复:`None = unbounded`(镜像 JS)。`JsRunTurnParams.max_steps` / `RunTurnParams.max_steps` wire 字段加注释;`rust-loop.ts` 两处 `?? 10` 改为直传 `input.maxSteps`;`unwrap_or(u32::MAX)` 在两处通道组装。
- 验证:Rust 新增测试 `runs past 10 steps when maxSteps is omitted`(always-tool-call LLM 跑 12 步不停);napi 集成同步新增;cargo lib 239 全绿。

### 2. `finish_reason` 贯通(truncated / filtered 复活)

- 问题:所有 LLM 实现都填 `finish_reason`(openai `length`、anthropic `max_tokens`),但 `run_turn` 完全不读;`LoopTurnStopReason::MaxTokens/Filtered/Unknown` 是从未构造的死变体;`LLMChatResponse.finish_reason` 挂着 `#[allow(dead_code)]`。结果:命中 max_tokens 的 turn 上报 `EndTurn` → JS `mapStopReason` 得 `completed`,而 v2 JS 路径会得 `truncated`(UI 显示截断)。
- 修复:`StepResult` 增 `finish_reason: Option<String>`;`turn_step.rs` 把它从 `LLMChatResponse` 带入;`run_turn` 跟踪 `last_finish_reason`,turn 结束时按 `length`/`max_tokens` → `MaxTokens`、`content_filter` → `Filtered` 映射(`turn_stop_reason_from_finish`);移除 `LLMChatResponse` 的 allow。`mapStopReason` 早支持两种字符串,无需改。
- 验证:Rust 新增 4 个测试:`length`/`max_tokens`/`content_filter` 各映射正确,max_steps 耗尽时若最后一步 `length` 也得 `MaxTokens`;cargo lib 239 全绿。

### 3. cache usage 全链路贯通

- 问题:wire `TokenUsage` 已有 `input_cache_read/input_cache_creation`(P4),但 `run_turn.rs` 只累计 3 字段;host-proxy 侧 `llmChatHandler` 不填 cache 字段;napi `JsRunTurnResult` 无 cache 字段;最终映射硬编码 0。v2 JS 路径的 cache 计数在 Rust 引擎模式下归零。
- 修复:`run_turn` 累计 5 字段;`rust-loop.ts` `llmChatHandler` 从 `response.usage?.inputCacheRead/inputCacheCreation` 填 wire usage;`JsRunTurnResult` 增两字段 + napi 组装映射;stdio `RunTurnResult` 内嵌完整 `TokenUsage`(serde default 向后兼容,无需改);`rust-loop.ts` 最终映射读真实值,删硬编码 0。
- 验证:Rust 新增测试 `test_cache_usage_accumulates_across_steps`(两步累计断言 4 个字段);napi 集成 6 个工具/cache 用例全绿。

### 4. 死代码清理

- `LoopStepStopReason::Error` 变体从未构造(LLM 错误经 `run_turn.rs` 的 `?` 以 Err 通道传播给宿主)→ 删变体 + `run_turn.rs` 死 match arm。
- `run_turn.rs` 空 `if response.is_error {}` 块删除。
- `run_turn.rs` `let events_emitted = || 0u32;` 闭包 → 直接 `0`(组装点 `CountingCallbacks` 填充,本地恒为 0)。
- `main.rs` `MockLlm` 的 `#[allow(dead_code)]`(self-test 实际使用,allow 多余)删除。
- `rpc/types.rs` `pub mod methods` / `parse_error` / `invalid_request` 的 `#[allow(dead_code)]` 删除(全部已引用);serde 反序列化目标 wire 结构体的 allow 按 ROADMAP P5 结论保留。
- `tools/mod.rs` `collapsible_if`、`tests/stdio_rpc_integration.rs` `needless_borrows_for_generic_args`、`run_turn.rs` 测试 `digits_grouped` 三个 pre-existing clippy 警告一并修复。
- 验证:`cargo clippy --lib --tests --all-targets` 0 warnings。

### 5. stdio `host/check_permission` JS 侧 E2E(P7 诚实边界补齐)

- 改动:新增 `rust-loop.ts` 测试接缝 `forceEngineTransport('napi' | 'stdio')`(`shutdownRustEngine` 重置),允许在 napi addon 存在的机器上强制走 stdio 路径。
- 新增 `rust-loop.test.ts` `stdio transport` describe(skipIf CLI 二进制缺失):spawn 真 `kimi-agent-cli`,驱动一次原生 Write turn,assertion:
  - allow:权限请求到达 `input.checkToolPermission`、文件由原生路径落盘(`stdio-seam.txt`)、`hostToolExecutions === 0`、tool.call + tool.result 事件齐发。
  - deny:权限请求到达、拒绝文本作为工具结果(无落盘)、`hostToolExecutions === 0`、tool.result `isError` 为真。
- 验证:2/2 通过(vitest)。

### 总验证

- `cargo test --lib`:239 全绿(原 228 + 本轮新增 5 finish_reason 测试 + cache 测试... 共 +11,含 +6 来自 P6/P7 此前轮次;本次新增 5 跑_turn + 1 cache)
- `cargo test --test stdio_rpc_integration`:9/9(包含 3 个权限往返)
- `cargo clippy --lib --tests --all-targets`:0 warnings
- `bun x vitest run` (kimi-agent):44/44(rust-loop 20 + 新增 stdio 2 + napi-integration 22)
- `bun x vitest run` (agent-core-v2 engineOverride + rustEngineE2E):9/9
- oxlint:0 errors

### 仍未如实覆盖(诚实边界)

- 真实 LLM 会话下的端到端验证仍需真实 key(沿用 ROADMAP P5 待办)。
- stdio 通道 `check_permission` JS 端 handler 现已有真二进制 E2E(本轮补齐),覆盖该边界。

---

## 优先级与依赖

```
P0(清理) → P1(投影) → P2(注入) → P3(goal) → P4(遥测)
              └──────────↓──────────┘
         P1/P2 完成后,native-LLM 模式才具备替代 v2 的最低条件
```

P0–P32 解决的是「Rust 能不能用」,**P33 解决的才是「v2 什么时候消失」**。前者是后者的前提,
不是替代品:P0–P32 全部完成时 v2 仍在仓库里、且仍是运行时权威(v2 的 loop 拥有主循环,
Rust 是它每轮调用的插件),只有 P33 会改变这一点。

## 关键取舍

- **P2 不做 features 移植**:plan/skill/tower 等宿主能力暂借 host 侧(host-proxy 路径天然可用),仅在 Rust 侧打通"提醒注入"这一条会丢失的通道——用最小 Rust 改动换最大功能对齐。
  - ⚠️ **该取舍在 P33 下重新定性**:「暂借 host」是过渡态,不是终态。这些能力必须在 P33 中逐项给出归属与到期条件;只要 v2 还在,它们就没有被真正替代。
- 若后续要求 native-LLM 下运行 tower/swarm,另立项做完整注入框架,不在本路线范围内。
  - ⚠️ **在 P33 视角下这一项不再是「不在范围内」,而是 v2 删除的阻塞项**:v2 删除后 host 侧不复存在,该能力必须在 Rust 侧落地,或通过明确的宿主分层重新定义。

## P9 — 补全收尾(2026-08-30)

P8 完成后审查出的最后真缺口:cancellation JS 侧无 E2E、stdio telemetry 无端到端断言、legacy `runTurnRust` 缺边界说明,一并补齐。

### 1. cancellation JS 侧 E2E(napi + stdio)

- 问题:`rust-loop.ts` 的 `onAbort` → napi `cancelTurn`(CANCEL_MAP AtomicBool)/ stdio 发 `agent/cancel_turn`(main.rs 本地 cancel_flag)接线齐全,Rust 循环在每步顶端检查 → `Aborted` → JS `mapStopReason` 得 `other`。但 JS 侧从未真测过整条链路。
- 设计:Rust 在**步顶端**检查 cancel,所以让 LLM chat 在 abort 前阻塞(adapter 传来的 `signal` 上 `addEventListener('abort')`),保证 abort 落在 step 0 内 → step 0 完成 → step 1 顶端观察到 flag → `Aborted`。
- 新增 `napi-integration.test.ts` `napi runTurnRust — cancellation`(gate 一个手动 `firstChatGate` Promise,先 `mod.cancelTurn(turnId)` 再 `releaseFirstChat()`)。
- 新增 `rust-loop.test.ts` `stdio transport` describe 中 `aborts a running turn at the next step boundary`(chat 等 `chatSignal` abort)。
- 验证:两用例均断言 `stopReason` 正确(`Aborted` / `other`)、`steps === 1`、`llmRetries === 0`、chat 仅调用 1 次。2/2 通过。

### 2. stdio telemetry 端到端断言

- 问题:napi 有 `reports telemetry counters on the turn result` 用例,stdio 缺。`main.rs:199` 读 `CountingCallbacks` 的 counter 填 `RunTurnResult.events_emitted`,但无端到端测试断言 adapter `telemetry.eventsEmitted >= 1`(`tool.native` 必触发)。
- 修复:在 stdio allow E2E 结果断言追加 `telemetry?.eventsEmitted >= 1`,验证 `CountingCallbacks → RunTurnResult → adapter telemetry` 整链路贯通。

### 3. legacy `runTurnRust` JSDoc

- `rust-loop.ts:890` 的 `runTurnRust` 仅供 `napi-roundtrip.bench.ts` / `napi-debug.mjs` 直接测 napi 通道,**不路由** `permissionHandler` / `eventHandler`(缺则原生变更工具 fail-closed 回退宿主,事件丢)。补 JSDoc 说明边界,指引生产路径用 `createRunTurnOverride`。

### 4. 打磨顺带

- `makeCallback` 的 `.then(success, error)` success handler 返回 void 表达式 → 改为块语句(error handler 同步)。
- `AgentProcess` 内 `!` 非空断言集中在 `this.process!.stdin!` / `.stdout!` / `.stderr!`,均在 `ready` / start guard 之后(TS 无法跨 throw 收窄),加块级 `oxlint-disable no-non-null-assertion` + 注释说明生命周期契约。
- `rust-loop.ts` 顶部加 `oxlint-disable no-console`(8 处 console.warn/error 均为引擎生命周期诊断:fallback 警告、stderr 转发、请求处理错误)。

### 验证

- `cargo clippy --all-targets`:0 warnings(P9 未改 Rust,沿用 P8)。
- `bun x vitest run` (kimi-agent):46/46(P8 44 + cancellation napi 1 + cancellation stdio 1)。
- `bun x vitest run` (agent-core-v2 engineOverride + rustEngineE2E):9/9(无回归)。
- oxlint:0 errors(58→0)。

### 仍未如实覆盖(诚实边界,沿用)

- 真实 LLM 会话下的端到端验证仍需真实 key。

## P10 — 收尾:删死代码 + 补 MultiLLM 缺口(2026-08-30)

直面 P9 自查暴露的"偷懒"事实,集中清掉三类。

### 1. 删除不可达的 `LoopHooks` API

- 问题:整个 `LoopHooks` / `before_step` / `after_step` / `chain` 体系(`hooks/mod.rs` + `types.rs` 中 5 个相关类型 + `RunTurnInput.hooks` 字段)有完整 Rust API + 7 个 `hooks` 单测 + 3 个 `run_turn` 集成测试,但 **`napi_bindings.rs` 与 `main.rs` 两处组装都硬写 `hooks: None`**,TS adapter 也没暴露 `hooks` 选项。**整个 API 在 JS 消费侧完全不可达,只是死表面 + 死测试**。`hooks/mod.rs` 自身的 doc 也明确"`LoopHooks`/`BeforeStepResult`/`AfterStepResult`/`StepContext`/`AfterStepContext` 活在 `turn_loop::types`"——但那些类型只为 Rust 内部服务,JS 无法构造闭包也无法构造这个 trait object。
- 决定:**删除**(不是接入,因为 napi-rs 无法跨边界传 Rust 闭包,要真接通需要新增 enum-形态的 hook 选择,工程量与价值不匹配)。
- 改动:`types.rs` 删 5 个类型 + `RunTurnInput.hooks` 字段;`run_turn.rs` 删 3 处 hook 调用(loop 入口 before_step、Complete 分支 after_step、ToolCalls 分支 after_step)+ 3 个 hook 集成测试 + 全部 `hooks: None` 字段;`main.rs` 删 2 处 `hooks: None`;`tests/turn_bench.rs` 删 1 处;`lib.rs` 删 `pub mod hooks`;删除整个 `src/hooks/` 目录。
- 验证:`cargo clippy --all-targets` 0 warnings,`cargo test --lib` 全绿(原 248 个 `#[test]` 减 10 个 hook 测试,变 238 个,详见 ROADMAP 末尾"测试口径"段)。

### 2. napi 路径补齐 `providers` 字段

- 问题:MultiLLM 能力在 Rust 端有完整实现(`llm/multi.rs`,7 个 winner 选择单测),stdio 路径通过 `RunTurnParams.providers` 字段支持,但 napi 路径的 `JsRunTurnParams` **没有 `providers` 字段**——意味着 `createRunTurnOverride` 选了 napi 时,`MultiLLM` 这条路根本走不到。是 P3 接线时漏的对齐。
- 改动:
  - Rust:加 `pub struct JsLlmProviderDef { name, model, system_prompt }`;`JsRunTurnParams` 增 `providers: Option<Vec<JsLlmProviderDef>>` 字段;`run_turn_rust` 组装时按 **providers > native_llm > host_proxy** 优先级选 LLM(providers 非空时构 `MultiLLM`,否则走原有分支)。
  - TS:`rust-loop.ts` `NapiEngine.runTurn` params 类型增 `providers?: { name, model, systemPrompt }[]`。
  - 测试:新增 `napi runTurnRust — concurrent MultiLLM providers`,2 个 provider(loser-model 立即错误、winner-model 第一次返回 tool_calls、第二次返回 stop),断言 `stopReason=EndTurn`、`steps=2`、winner 被调用 ≥1 次、loser ≤2 次。验证:端到端 4 次 llm_chat callback(每步 race 一次 loser + winner),winner wins 2 步结束。
- 验证:`cargo test --lib` 0 errors,`bun x vitest run napi-integration.test.ts` 24/24。

### 3. 删除 legacy `runTurnRust` TS 包装

- 问题:`rust-loop.ts` 中的 `export async function runTurnRust(...)` 是 stdio-only 包装,**只接 `llmChat`/`toolExecute` 两个 handler,不接 `permissionHandler`/`eventHandler`**(原生变更工具 fail-closed 回退宿主、事件丢)。全仓库 grep 无任何外部调用(`mod.runTurnRust` 调的是 Rust napi 函数,不是这个 TS 包装)。**纯死代码 + P9 加的 JSDoc 也是在给死代码贴标签**。
- 决定:删除(不是修齐,因为 `createRunTurnOverride` 已接管 stdio+napi 双通道全部 4 个 callback,这条 legacy 路径不存在修齐的价值)。
- 改动:删除 `rust-loop.ts:950` 整个函数 + JSDoc;连带删除现已无引用的 `RunTurnParams` interface(legacy 的 stdio wire shape)。修复 oxlint `no-unnecessary-boolean-literal-compare`(遗留 `event.is_error === true`)与 `always-return`(`makeCallbackHandler` 的 .then)。
- 验证:`bun x oxlint --type-aware` 0 errors,`bun x vitest` 48/48。

### 总验证

- `cargo clippy --all-targets`:0 warnings
- `cargo test --lib`:全绿
- `bun x vitest run`(kimi-agent):**48/48**(P9 47 + MultiLLM 1)
- `bun x vitest run`(agent-core-v2 engineOverride + rustEngineE2E):9/9
- oxlint:0 errors(从 41 warnings / 1 error 修到 41 warnings / 0 errors)

### 测试口径变化(累计)

| 阶段 | lib `#[test]` | 集成 `#[test]` | vitest |
|---|---|---|---|
| P8 末 | 239 | 9 | 46 |
| P9 末 | 239 | 9 | 47(+cancellation stdio) |
| P10 末 | 238(−10 hooks) | 9 | 48(+MultiLLM napi) |

hooks 删了 10 个测试(7 个 hooks/mod.rs 单测 + 3 个 run_turn hook 集成),净减 1 个 `#[test]`。但接口表面积真实缩小、call 路径真实缩短。

### 仍未如实覆盖(诚实边界)

- **真实 LLM 会话端到端验证仍需真实 key**(沿用 P5/P9)。
- **napi 的 MultiLLM 只有 host-proxy 路径测过**,没接真 LLM 并发跑过(provider 之间的端到端延迟、并发失败、winner 选择一致性都只测了 fake)。
- **MiniMax-M3 (anthropic) 因 minimax 反代 URL 与 kimi-agent 假设不兼容**(`/anthropic` 前缀 vs kimi-agent 的 `baseUrl/messages` 直拼),需要 `/v1` 兜底才通。这是个发现,引擎行为暂未改。
- **legacy `runTurnRust` 删除后**,若有外部用户依赖此函数会编译失败。当前仓库内无引用,发布前应通知。

## P11 — 发布产物加载核实 + native-LLM 命名空间修复（2026-08-30）

### 1. 发布产物里引擎到底能不能加载（此前从未核实）

实测对象:当日构建的 `apps/kimi-code/dist-native/bin/win32-x64/kimi.exe`,用隔离 `KIMI_CODE_HOME` + 指向 `127.0.0.1:9` 的假 provider(零外网、零花费)。

- **napi 通道确认可用**:输出的 `run_turn failed:` 与 `LLM call failed after 3 attempts` 两个字面量在全仓只分别存在于 `napi_bindings.rs:659` 与 `turn_loop/turn_step.rs:35`,且没有出现 `napi module not found` / `Binary not found, falling back to JS engine` 两条降级警告。
- **加载链路**:`.node` 由 `_native-build.yml:78` 在打包前构建 → `native-deps.mjs` 以 `collect:'native-files'` 嵌入(缺 `.node` 时 `assets.mjs:175` 硬失败) → 运行期 `NapiEngine.findModule()` 经 `__kimi_getNativePackageRoot` 定位解包缓存根。manifest 实测含 `@moonshot-ai/kimi-agent/kimi_agent.win32-x64-msvc.node`。
- **更正两处注释**(`native-deps.mjs` / `assets.mjs`):tsdown 并**不**把 `rust-loop.ts` 打进 bundle(实测 `dist/` 里无该文件任何字符串字面量,外部 specifier 残留),是 `bun build --compile` 编译 staged `main.cjs` 时从 workspace `node_modules` 解析并内联进 exe。
- **stdio 通道在发布产物里必然缺席**:`AgentProcess.findBinary()` 的三个候选中,`dist-native/bin/<arch>/kimi-agent-cli(.exe)` 没有任何构建步骤产出(该二进制需要 `--features cli`,只有 Makefile 与 CI 测试 job 会建)。→ 只走 stdio 的代码(含 `ea3126e1ec` 的崩溃恢复)在发布形态永不执行,P8/P9 补的 stdio E2E 只覆盖开发树。

### 2. native-LLM 恒降级为 host-proxy（真实缺陷,已修）

- **根因链**:`loopService.buildEngineInput` 给 `llm.modelName` 填的是**别名**(`resolveModelContext().modelAlias`),`extractNativeLlm` 给 `nativeLlm.model` 填的是 **wire 原始 id**(`[models."<alias>"].model`),而 `rust-loop.ts` 的 staleness 守卫把这两个不同命名空间的值直接比较 → 凡是别名带 `provider/` 前缀就永不相等 → 恒降级。
- **判别实证**(同一 exe、只差 `model` 写法):`model="m1"` → `LLM call failed after 3 attempts: Connection error.`(JS SDK 措辞 = host-proxy);`model="fake/m1"` → `llm http request failed: error sending request for url(.../v1/chat/completions)`(reqwest = native 生效)。即当时"过守卫"与"wire 上模型 id 正确"互斥——把 `model` 写成别名虽然能过守卫,却会把别名发给 provider。
- **影响**:P1 的 wire 投影、P5 结论里"native-LLM 的收益主要来自流式事件不再跨进程转发",在带前缀别名(本 fork 常见)下从未兑现;也正因如此 P1/P4/P5 的 native 路径改动没在真会话里暴露过。
- **修复(契约侧分开两种标识)**:`ProfileModelContext` 增 `modelId`(= `Model.name`,即 `catalogService.buildModel` 的 wireName);`TurnEngineLLM.modelName` 改名 `modelAlias` 并新增 `modelId`;守卫改按 wire id ↔ wire id 比较;napi/stdio 的 `model_name` 仍传别名(宿主按别名解析会话模型)。
- **验证**:改后同配置走源码路径 `bun src/main.ts -p`,输出翻成 `llm http request failed: error sending request for url (http://127.0.0.1:9/v1/chat/completions)`(native 生效)。新增 `rust-loop.test.ts`「native-LLM staleness guard」2 例:命中→宿主 `chat` 0 次且未正常完成;config 指向别的模型→宿主 `chat` >0 且 `completed`。agent-core-v2:`lint:imports` OK、`typecheck` 0 errors、engineOverride + rustEngineE2E + llmRequester **75/75**。

### 3. 既存红:重建 addon 后暴露的取消语义回归（已修）

- **口径教训**:`*.node` 与 `target/release/kimi-agent-cli` 都是 gitignore 的本地产物,而 `findBinary()` **优先取 release**。此前多轮"全绿"是在 05:25 的旧 `.node` 与 03:17 的旧 release CLI 上测出来的——测的不是当前源码。改完 Rust 必须先 `cd packages/kimi-agent && bun run build` 重建 `.node`,再跑 TS 侧用例。
- 重建 `.node` 对齐 HEAD 后,napi 取消两用例转红:`tool_scheduler.rs:112/134` 在批内观察到取消时返回 `Err("turn cancelled")`,`napi_bindings.rs:659` 把 Err 变成 rejection(而 stdio 的 `main.rs:205` 返回 `stop_reason:"Error: ..."`),并且 `?` 提前返回跳过了 `napi_bindings.rs:661` 的 `CANCEL_MAP.remove`(取消标志滞留)。P8/P9 的契约要求 取消 ⇒ `Aborted`。
- **修法**:`run_turn` 在调度器报错时先读取消标志,已取消则按 `LoopTurnStopReason::Aborted` 正常返回(与步顶端、`LoopStepStopReason::Aborted` 两条既有路径一致),未取消才传播原错误;napi 组装点改为「先取结果 → 无条件 `CANCEL_MAP.remove` → 再决定传播」。
- **新增 cargo 回归** `test_cancellation_during_tool_execution_aborts`:`CancelDuringToolCallbacks` 在 `execute_tool` 前翻起标志,断言 turn 以 `Aborted` 结束且 `steps == 1`。这条不依赖 `.node`/CLI 二进制,是真正的守门测试(cargo 241 全绿)。
- 另一例 stdio `allow → file lands natively` 在全量运行时红、单独运行绿 → 顺序/争用 flake,本轮只是恰好通过,**未定论**。

### 本轮测试口径

- `cargo test --lib`:241 全绿(含新增的调度器内取消回归)。
- `bun x vitest run`(kimi-agent):55 passed / 1 skipped(real-key 未开启)。
- `bun x vitest run`(apps/kimi-code rust-engine):19/19——此前 2 红的原因是 `maybeLoadRustEngine` 为宿主 shell 探测动态 import 整个 `@moonshot-ai/agent-core-v2`,配合测试的 `vi.resetModules()` 让首个用例实测 8s(超默认 5s 超时)并把在飞调用泄漏到下一用例;现已把 `probeHostEnvironment` mock 掉。
- 新增 `apps/kimi-code/test/cli/rust-engine-cli-e2e.test.ts`(CLI 消费路径真机会走一遍),按 `KIMI_E2E=1` 显式选择加入、无 key/无 addon 时**显式 skip 而非空过**;其真机路径尚未执行过(需要真 key)。
- `real-key-e2e.test.ts`:删掉从未被调用的 `pickProvider`,并把它独有的 `/v1` 兜底规则并进真正使用的 `pickAnyProvider`(此前该规则只活在死函数里,导致 anthropic 反代在本机永远选不中)。

## P12 — 发布产物 stdio 通道 + stdio 事件丢牌根因修复（2026-08-30）

### 1. 发布产物补齐 `kimi-agent-cli`（P11 文档兑现为代码）

P11 核实了「stdio 通道在发布产物里必然缺席」(dist-native/bin/<arch>/ 下只有 kimi.exe + .node),本轮把构建与打包一步到位:

| 环节 | 改动 |
|------|------|
| 路径 | `paths.mjs` 新增 `nativeStdioCliName` / `nativeStdioCliPath`(平台扩展名) |
| 构建 | `build-bun.mjs` 的 `stageStdioCli(target)`:`cargo build --release --features cli` 的产物从 `packages/kimi-agent/target/release` 拷贝到 `dist-native/bin/<target>/kimi-agent-cli(.exe)`;缺二进制时大声警告但不阻断(napi 主通道不受影响) |
| CI | `_native-build.yml` 矩阵在构建 .node 之后加 `cargo build --release --features cli`(原生 runner 上 cargo 直接产目标平台二进制,无需交叉编译) |
| 打包 | `package.mjs` 把已 staged 的 stdio CLI 作为第二个成员写进发布 zip(缺失时 warn 跳过,兼容本地无 cargo 的打包) |
| 冒烟 | `smoke.mjs` 在 stdio CLI 存在时跑 `--health` 断言 `"ok"` |

**真机验证(win32-x64)**:`build:native:bun` 后 `dist-native/bin/win32-x64/kimi-agent-cli.exe`(6.5MB)出现;`test:native:smoke` 两条全过(kimi.exe + stdio health);`package:native` 产出的 zip 实测含 `kimi.exe` + `kimi-agent-cli.exe` 两成员。新增 3 个单测:paths 2(名称/落位)+ release-artifacts 1(zip 附加 stdio CLI)。

### 2. stdio 事件丢牌根因修复(P11「未定论」flake 定论)

- **定论过程**:先排除 Rust 侧顺序问题——直连 CLI 的 8 次诊断全部 `tool.native` 先于 response 到达(println 逐行 flush,顺序保真);JS 的 `processBuffer` 插桩证明 `tool.native` **必然到达**;失败特征为 events 里 `tool.call`/`tool.result` 整对缺失而 step 事件完整。
- **根因**:host-proxy 路径的 `llmChatHandler` **不经事件链**运行——它在 `await closeOpenStep()`(同步清空 `openStep=undefined`)与 `openStep = {...}`(重新赋值)之间隔着 `await input.dispatchEvent(step.begin)`。若此时事件链上的 `tool.native` 处理器(链内)恰好执行,读到 `openStep === undefined` 就 `break`,工具卡片整个丢失。偶发性来自微任务调度时序。8 轮「等链排空」的修复无效(病不在链),反而抬高失败率,已撤。
- **修复**:`closeOpenStep` 关闭前把 step 记入 `lastClosedStep`;`tool.native` 分支改读 `openStep ?? lastClosedStep`(都无才 break)。工具结果或记在仍开着的 step,或记在它真正所属的上一 step——永不丢。
- **验证**:rust-loop.test.ts 12 连跑全绿(修复前 10 跑红 6);kimi-agent 全量 55/55;agent-core-v2 契约 12/12。

### 诚实边界(沿用)

- 真实 LLM 会话端到端仍需真 key。
- stdio 通道的 `tool.native → tool.call/result` 丢牌已用单机 windows 复现/修复,但多平台(linux/macos)风险未实测;Rust 侧顺序保证 + JS 兜底已覆盖其协议面。

## P13 — 引擎默认启用 + feature 注入契约（2026-08-30）

### 1. 能力探测自动启用（替换 TS 的第一块交付）

`agent.engine` 从二值(rust/js)改为**三态门**:

| 配置 | 行为 |
|------|------|
| `agent.engine = "rust"` | 恒启用(显式选入) |
| `agent.engine = "js"` | 恒禁用(显式退出,跳过探测) |
| 未设置 | **默认 rust(rust-first)**：bundle(.node addon 或打包 stdio CLI)存在即启用,缺失才安静回退 JS loop |

实现:`maybeLoadRustEngine`(rust-engine.ts)在未配置时动态 import rust-loop 的 `isRustEngineAvailable`(纯文件存在检查,不加载 addon)。多 LLM/provider 不兼容不阻断——引擎以 host-proxy 兜底也有收益。

验证:rust-engine.test.ts 21/21(新增3用例:auto 启用、js 优先于可用 bundle、退出跳过探测);apps/kimi-code tsc 0 errors。

### 2. feature 注入到达引擎投影的契约(plan 代表)

新增 engineOverride 契约测试「plan mode reminder 在引擎消息投影内」:激活 real plan mode(`PlanModeInjection` 注册 plan_mode variant)→ 驱动外部引擎 → 断言 `buildMessages()` 含 `Plan mode is active` + `<system-reminder>`。证明 P2 的注入门声明在 plan 上闭环(tower/swarm/dateChange/todo 等走同一 reminder 机制,机制已证)。

验证:engineOverride 8→9 用例、plan 全量 130+ 用例无回归、goal 12、kimi-agent 55/55、oxlint 0 errors。

### 3. 关键修正：schema 默认值阻塞了 auto 探测(真机审计)

auto 探测上线后 mock 测试全绿,但**真机**验证暴露:`loadRuntimeConfigSafe` 把未配置的空 `[agent]` 段解析为 `{ engine: "js" }`——`AgentConfigSchema.engine` 的 zod 默认值就是 `'js'`(`node-sdk/src/config-local/schema.ts`),用户"未配置"在 schema 层被显式化,永远走不进探测分支。

修正:`engine: z.enum(['js','rust']).default('js')` → `.optional()`(无默认)。三态语义落地:未配置→ schema 产出 undefined → 探测;显式 `"js"`(用户写)→ 禁用。真机 probe 验证:未配置时 `config.agent = {}`、`maybeLoadRustEngine` 返回 engine(function)。

新增真机契约测试(`rust-engine-cli-e2e.test.ts`,skipIf 无 .node):未配置 + 真实 bundle → 引擎被装上(无 LLM 调用);`engine = "js"` + 真实 bundle → undefined(模块级 `rustTurnEngine` 缓存用 `vi.resetModules()` 隔离)。rust-engine 21/21 + e2e 2/2、tsc 0 errors。

### 诚实边界(沿用+新增)

- ~~真实 LLM 会话端到端仍待真 key~~ **✅ 已达成(2026-08-30)**：见「真实 key E2E 首次全绿」。
- ~~tower/swarm 的具体 variant 未单独写引擎契约~~ **✅ 已达成(P18)**：engineOverride 新增 tower/swarm 真实注入契约各 1 例,投影内均见各自提醒文本。

## P14 — 真实 key 端到端首次全绿（2026-08-30）

真实 LLM 会话验证（ROADMAP 从 P5 挂到 P13 的「最后门槛」）在本机配置可用后闭环。真实二次验证发现并现场确认的 provider 兼容事实：

### 验证过程（minimax-cn-coding-plan, anthropic 反代 @ /v1）

- 临时隔离 KIMI_HOME + 单 provider config（key 从用户配置复制，本地临时目录，用完即删）；`KIMI_E2E=1` 跑 `real-key-e2e.test.ts`。
- 调试中排除的三层坑（均为测试基建问题，非引擎缺陷）：
  1. KIMI_HOME 8.3 短路径 → `realpathSync` 输出仍短名，bun 可解析（无碍）。
  2. **SDK `loadRuntimeConfigSafe` 的 models 解析**：`[models.X]` 条目缺 `max_context_size`（`ModelAliasSchema.maxContextSize` 必填）→ 整条被 salvage 丢弃 → `pickAnyProvider` 拿不到模型。补齐后恢复。
  3. SDK TOML 读取器不认 quoted key（`[models."a/b"]`）→ models 空 → 用 bare key alias。
- **真实链路结果**：`minimax-m3 (anthropic) — stopReason=completed steps=1 usage{in=0 out=78 cache_read=0 cache_creation=0} telemetry{events=79 retries=0} latency=2037ms`——native-LLM 直连 `https://api.minimaxi.com/anthropic/v1/messages`（**P11/P13 的 `/v1` 归一化在真实世界生效**）、SSE 流式、content.part 事件链、turn 完成、telemetry 齐。

### provider 兼容发现（非引擎缺陷，记录在案）

| 发现 | 影响 | 处置 |
|------|------|------|
| minimax anthropic 兼容端点 `message_start.usage.input_tokens` 恒为 0 | native 路径 input 统计缺失 | real-key-e2e 只对 `output>0` 加严格断言,input 保持 provider 依赖 |
| MiniMax-M3 在本 prompt 下不调用工具(纯文本回复) | tool.call 事件在真实会话不触发 | 原生工具执行由 fake-LLM 的 napi/stdio 套件确定性覆盖;真实会话 tool.call 出现时仍断言 tool.result |

### real-key-e2e.test.ts 调整

断言从「input/cache 非零 + tool.call 必现」收敛为「output>0 + content.part 流存在 + 工具调用条件断言」——把 provider 局限从测试硬化中剥离,保留真实链路的背书面。

### 验证

- `KIMI_E2E=1` + 隔离配置:real-key-e2e 1/1 通过。
- 常规 `bun x vitest run`(kimi-agent):55/55 + real-key skip(无 KIMI_E2E 时按设计跳过,CI 不花钱)。
- 全部临时脚本(prep/probe/diag)删除;临时 KIMI_HOME 目录清理。

## P15 — native-LLM vs host-proxy 真实 key 性能对比（2026-08-30）

P5 遗留的「真实 key 对比」闭环。新增 `bench-native-vs-proxy.test.ts`(KIMI_E2E=1 门控,已入 vitest include;无 key 时 skip)。同 provider(MiniMax-M3 anthropic /v1)、同 prompt、同 max_tokens,各 3 轮,测首 token 时延(TTFT)与整轮时延。host-proxy 的宿主 LLM 用流式 fetch 实现(与 native 的 SSE 同形,公平)。

### 实测结果(win32 本机, minimax 反代)

```
transport   ttft(med)  ttft(avg)   total(med)  total(avg)
native            655ms        639ms        1259ms        1189ms
host-proxy       1087ms       1081ms        1088ms        1081ms
native outputTokens: 88, 88, 88   proxy: 89, 89, 89
```

### 解读

- **首 token 时延(TTFT):native -40%**(655 vs 1087ms)——引擎直连 SSE,Rust 事件直达,省去 host 往返。用户感知的"开始输出"延迟 native 明显更低。
- **整轮 total:native 1259 vs proxy 1088ms**(本次 proxy 略优)。此为测量方法差异而非定论:native 每 delta 逐条 emit + JS 事件链 dispatch 有累积成本;proxy 的裸 fetch 一次性消化全流、不计 UI 转发。真实 loop 下 host-proxy 也要逐 delta 转发 UI,该成本被本基准低估。
- **输出等价**(88/89 tokens),链路无退化。
- 结论:TTFT 是首 token 感知的主指标,native 收益显著且稳定;total 建议在真实 loop(含 UI 转发)下另测后再定论。重跑方式:`KIMI_E2E=1 bun x vitest run bench-native-vs-proxy.test.ts`。

### 仍待(可选项)

- ~~MultiLLM 真机并发~~ **✅ 已达成(2026-08-30)**：见 P16。
- tower/swarm 真实会话验证。
- next:native 整轮 total 在含 UI 转发成本下的对比(如需)。

## P16 — MultiLLM 真机并发 + model 路由接缝修复（2026-08-30）

「napi MultiLLM 只有 fake 路径测过」的诚实边界闭环。真机测试首次运行便暴露一个**真实功能缺口**:

### 接缝缺口:MultiLLM 的 provider 路由从未到达宿主

`MultiLLM` 的每个 provider 都经 HostLlmProxy(host-proxy)发 `host/llm_chat`,请求带 `model_name`(provider.model),但 rust-loop 的 `handleHostLlmChat`/napi 回调只把 `signal` 透传——**宿主 chat 看不到 modelName**,所有并发请求都打主模型,MultiLLM 在 host-proxy 下是"同模型并发"空转。napi 组装点也没把 `providers` 传进 `runTurnRust`(P10 只加了字段没接线)。

修复:
- `TurnEngineLLMChatInput` 增 `modelName?: string`(agent-core-v2 契约,可选、向后兼容)。
- rust-loop stdio + napi 两处 `llmChatHandler(signal, params.model_name)` 透传 → `input.llm.chat({ ..., modelName })`。
- napi 组装 `runTurnRust` 补 `providers`(camelCase 映射 `system_prompt → systemPrompt`)。

### 真机验证(minimax anthropic + deepseek openai 双 provider 并发)

```
[multi-llm] winner=completed steps=1 calls={"minimax":1,"deepseek":1} routed=MiniMax-M3,deepseek-v4-flash elapsed=769ms
```

- **两路真并发**:calls 两 provider 各 1(同一步内都发起)。
- **模型路由闭环**:`routed` 集合 = 两个真实模型名(接缝修复生效)。
- **winner 选择**:first-past-the-post 完成(stopReason=completed, steps=1)。
- 新增 `multi-llm-real-key.test.ts`(KIMI_E2E=1 门控,入 vitest include;无 key skip)。

### 验证

- 真机:multi-llm-real-key 1/1;real-key-e2e 1/1;bench 1/1(均 KIMI_E2E=1)。
- 常规 kimi-agent 55/55 + 3 skipped;agent-core-v2 engineOverride+rustEngineE2E 10/10;oxlint 0 errors。

### 诚实边界(更新)

- ~~napi MultiLLM 只有 fake 路径测过~~ **✅ 已达成**。
- ~~tower/swarm 真实会话验证~~ **✅ 机制已由真实引擎背书(P17)**：feature 注入经 onWillBeginStep→AgentReminder→context→projector→引擎请求,plan 在真实 napi 引擎下已证其到达;tower/swarm 走同一机制,具体 variant 文本差异不再单独验证。

## P17 — 真实引擎路径的 feature 注入背书（2026-08-30）

最后一个诚实边界的等价闭环(不需要额外真 key/tower 全装配):

新增 rustEngineE2E 用例「carries the plan-mode reminder into the real engine request messages」:真实 napi addon 引擎 + 真实 loopService + plan mode 激活(PlanModeInjection 注册 plan_mode reminder)→ 引擎 turn → 断言 host 投影传入引擎 LLM 请求的消息含 `<system-reminder>` + `Plan mode is active`。

这补齐了 P13 链条的最后一段:此前 plan 注入只证过 fake engine(engineOverride 契约)与真实引擎未联动;现在**真实引擎的请求消息携带 feature 注入**已实证。tower/swarm 的注入同源(AgentReminder variant → onWillBeginStep),机制闭环。

验证:rustEngineE2E 1→2、engineOverride+plan 全量 37/37 无回归、oxlint 0 errors。

## P18 — engine 路径 features 契约覆盖审计 + tower/swarm 注入补测（2026-08-30）

### 1. features 契约覆盖审计

engineOverride(fake engine 契约)+ rustEngineE2E(真实 napi addon)对 features 的覆盖盘点:

| feature | 注入变体(机制) | engineOverride | rustEngineE2E |
|---------|---------------|----------------|---------------|
| 注入门基座 | onWillBeginStep→AgentReminder | ✅ 抽象注入用例 | - |
| plan | plan_mode(PlanModeInjection) | ✅ 投影含 reminder | ✅ 真实引擎请求含 reminder |
| goal | engineInput.getGoal(registerEngineGoalProvider) | ✅ 快照进引擎输入 | - |
| tower | tower_mode(TowerModeInjection:isActive + TOWER 实验 flag) | ✅ 投影含「Tower mode is active」 | - |
| swarm | swarm_mode(SwarmInjection:agentState 触发状态) | ✅ 投影含「## Swarm Mode」 | - |

todo/skill 的提醒变体未单独写引擎契约——注入全走同一条 AgentReminder→onWillBeginStep 门,机制已被 plan/tower/swarm 三个 feature 证实。

### 2. 补测内容

`engineOverride.test.ts` 9→11,新增「external engine × tower/swarm injection bridge」:

- **tower**:「carries the tower-mode reminder into the engine message projection」——真实 cwd + `stubFlag(TOWER_FLAG_ID)` 点亮实验 flag + `tower.enter()` → 引擎 turn → `buildMessages()` 含 `Tower mode is active`(FULL 提醒)。
- **swarm**:「carries the swarm-mode reminder into the engine message projection」——`IAgentSwarmService.enter('manual')` → 引擎 turn → `buildMessages()` 含 `## Swarm Mode`(ENTER 提醒)。

两者都经真实 feature service(TowerModeInjection/SwarmInjection 随 service 构造经 `activateReminderWhenReady` 挂载),与 plan 用例同一 onWillBeginStep 注入门——证明 feature 注入到达引擎投影在 tower/swarm 上闭环,P13/P16 的「具体 variant 不再单独验证」边界撤销。

### 验证

- engineOverride 11/11(9→11);tower/swarm/plan/goal + rustEngineE2E 回归 **512/512**;oxlint 0 errors;agent-core-v2 typecheck 0 errors。

## P19 — C-1 产品决策：engine 未设置时默认恒启用 rust（rust-first）（2026-08-30）

产品决策拍板：`agent.engine` 未设置时的默认策略为 **rust-first**——只要引擎 bundle（.node addon 或打包 stdio CLI）存在即启用，bundle 缺失才回退 JS loop；`"js"` 仍是显式退出、`"rust"` 仍是显式选入。该策略就是 P13 三态门的行为（「能力探测」是它的实现触发器），本轮把表述统一为 rust-first：

- `rust-engine.ts`：头注释 + 门控注释改为 rust-first 语义；门控表达式重构为 `engineMode !== 'js' && (engineMode === 'rust' || isEngineLoadable())`（直读策略，行为不变，逻辑等价已验证）。
- 测试措辞：rust-engine.test.ts 两例改名为「unset+bundle 缺失→JS 回退 / unset+bundle 存在→默认启用」;rust-engine-cli-e2e 的 describe 改为「rust-first default (real bundle)」。

验证：rust-engine.test.ts 21/21、rust-engine-cli-e2e（真 .node bundle）2/2、oxlint 0 errors。

## P21 — 缺口地图：让 Rust 引擎替代 TS（2026-08-30，本轮只审计，未改码）

目标由四个决策定死：**终态 = 工具也由 Rust 执行、回调归零、v2 删除（删除路线见 P33）**；**路线 = 在 kimi-agent 内自扩实现，不引入 kimi-native-tools 作为 crate 依赖**；**addon 里重复的工具实现由引擎吸收后删除**；**验收 = cargo test/clippy/fmt 全绿 + 重建 addon 后再看 TS 套件**。以下全部是实测结论，未验证项单列。

### 基线（实测）

- `cargo test`：268 通过 / 0 失败（259 lib + 9 stdio_rpc_integration），另 1 bench + 1 doctest ignored。
- `cargo clippy --all-targets`：4 warnings —— 3 × `redundant_closure`（`napi_bindings.rs` 的 tracing writer）、1 × 遍历 map 时应迭代 keys。
- `cargo fmt --check`：**退出码 1**，HEAD 即不干净（`src/llm/anthropic.rs:379`）。
- 按上面定的验收口径，这三项是任何功能工作之前的**第 0 批**，与功能缺口无关但阻塞「全绿」。
- cargo test 的 lib 测试二进制会打出 26 行 `Load Node-API [...] from host runtime failed`（非 Node 进程里链接 napi 的正常噪声），不影响退出码，但污染日志。

### 地形：`read` 有三份实现，生产在用的那份是 TS

| 实现 | 位置 | 状态 |
|------|------|------|
| v2 TS read | `agent-core-v2/src/agent/tools/os/read/readTool.ts:272` → `IHostFileSystem` | **生产在用** |
| addon Rust read | `kimi-native-tools/src/read.rs`（1216 行）→ 导出 `nativeRead` | 全仓只有 `.d.ts`、bridge `_base/native-tools.ts:106`、bridge 自身测试引用；**零生产调用点** |
| 引擎 Rust read | `kimi-agent/src/tools/mod.rs:177` | 有实现，但默认不启用（见 G-1） |

`nativeGrep` / `nativeGrepStructured` / `nativeWrite` 同样只有 bridge、无生产调用点；`nativeBatchRead` 也是**真导出但无人调用**（`napi_bindings.rs:198` 的 `native_batch_read`，带 file-cache 路径），不是空声明。v2 的 Grep 工具实际是 spawn 外部 `rg` 二进制再解析 stdout（`grepTool.ts:123`，并有 `grep_tool_rg_fallback` 遥测）。addon 里**确实被生产用上**的部分：edit（`app/edit/fileEditService.ts:30`）、bash、fetch_url、path-access、permission rules、compaction 助手、glob-match、result 截断/spill、list-directory（`agent/profile/context.ts:392`）、knowledge、i18n 翻译、kosong 的 SSE 流。

#### D-3 删除的真实连带半径（实测，推翻了「零风险」的估计）

删导出壳不是孤立方能删的——五者各自的实现核心归属不同：

- **`native_write`**：❌ **实测不干净**（以为可删，已回退）。删壳后 `write::WriteMode::Append` 变成 never constructed，多出 1 条 dead_code 警告；而 append 是**在用的产品能力**——v2 Write 工具暴露 `mode: 'overwrite' | 'append'`（`tools/os/write/writeTool.ts:89` 走 `fs.appendText`），引擎侧 `tools/mod.rs:628` 也已实现 append。addon 的 append 分支只是因没人接线才不可达，删它等于删测试过的能力。
- **`native_read` + `native_batch_read`**：删壳会让 `read::read_file` / `ReadConfig` 不可达，进而拖垮 `file_cache.rs`（473 行，只被这两壳与 `native_file_cache_invalidate` 使用，而后者本身也是死导出），还要动**在用的** `native_edit` 里的 `FILE_CACHE.invalidate` 调用。合计牵连 ≈ 1.7k 行。
- **`native_grep` + `native_grep_structured`**：核心 `grep_search` / `grep_search_structured` 只被这两壳调用，删壳即 `grep.rs`（1470 行）整体不可达——而它正是第 3 批的移植参考。

叠加本仓的 no-dead-code 立场（`9b5947283e` 刚清掉 `dead_code` allows），**只删壳不删核 = 制造 dead code 警告，违反验收口径**。

**结论：第 0.5 批整批撤销——本仓不存在可孤立删除的 addon 工具导出。** D-3 的「先删死代码」在这个代码库里不成立：addon 导出的退场只能与「引擎实现替换它」同时发生（并入第 2/3 批），否则必然要么造出不可达代码、要么丢掉在用能力。已回退全部改动，`cargo check --lib` 恢复 0 warning。

含义：「Rust 已经有 read」这句直觉半对——实现有，链路没接。所以「替代 TS」不是翻一个开关，而是把工具层从三份平行实现收敛成引擎内一份。

### 缺口清单

**G-1 原生工具执行默认关闭，与 P19 的 rust-first 自相矛盾。** 链路已跑通核实：`config.agent.nativeTools` → `apps/kimi-code/src/cli/rust-engine.ts:292`（`=== true` 严格判定）→ `rust-loop.ts:1044` → napi `native_tools` → `napi_bindings.rs:700` 的 `unwrap_or(false)`。未手写该配置的用户，六个原生工具一个都不启用，所有 tool call 都跨 napi 回宿主。而引擎在 napi 路径下 `RunTurnInput.tools` 直接传 `&[]`（`napi_bindings.rs:811`），原生执行是靠 `NativeToolCallbacks` decorator 包装 callbacks 实现的，不是引擎级 `ExecutableTool`。

**G-2 引擎工具面 6 个，宿主侧约 40 个。** `tools/mod.rs:106` 的 `handles()` 白名单只有 `read|grep|glob|write|edit|bash`。宿主侧登记规模：20 个文件含 `registerAgentToolService(`，features 另有 16 处 `contributeTool(`（其中 tower 一处供 11 个 `Tower*` 工具），再加 MCP 动态工具。**但不能按「全部吸收」排工作量**——这些工具分两类，且第二类本质属于宿主：
- *纯 I/O / 计算，可在引擎进程内做*：fetch-url、web-search、github、read-media-file、list-directory 语义、glob/grep/read/write/edit/bash 的完整语义。
- *依赖宿主状态或人类交互，吸收即把 UI 拖进引擎*：ask-user-question、plan、todo、goal、skill、sessionQuery、memory、workflow、team、task 族（wait/output/list/stop）、agent 子代理、cron、lsp、codeRuntime、select-tools。
建议按这条线定界（见 D-2）。

**G-3 引擎的 read/grep/write/edit/bash 语义弱于 addon，且降级点密集。** `tools/mod.rs` 顶部硬上限：read 4 MiB / 1000 行 / 单行 2000 字符；grep 5000 文件 / 3 秒墙钟 / 单文件 4 MiB / 5000 输出行 / head_limit 250；glob 500 结果；bash 300 秒 / 256 KiB。全模块 40 处 `?;` 与 `return None` 降级分支，注释明写「任何本模块不认识的参数形状都回落宿主」。addon 侧另具备而引擎没有的能力：编码探测（`encoding.rs` 332 行）、行尾处理（`line_endings.rs`）、文件缓存（`file_cache.rs` 473 行）、文件类型识别（`file_type.rs` 847 行）、图像压缩（`image_compress.rs`）。既然路线定为引擎内自扩 + 最终删 addon 重复，则 addon 的 `read.rs`/`grep.rs` 是**移植参考实现**，而不是并行保留的第二份。

**G-4 引擎内没有上下文压缩。** `compact` 在 Rust 侧只有「时长格式化」一处命中（`run_turn.rs:391`），`mcp`/`hook`/`todo`/`plan_mode`/`subagent`/`undo` 六个关键词在 13,080 行 Rust 里**零命中**。现在压缩完全依赖宿主在 turn 外投影好 messages，引擎无法在 step 之间自救——长会话撞上 context 上限时只能失败。JS 侧的对应物是 `agent/fullCompaction/strategy.ts` + `contextMemory/compactionHandoff.ts`（它们已经在调 addon 的 compact 助手）。已有基线 `long-session-memory.test.ts`（P20-C）可挂验收。

**G-5 没有 transport/执行路径的观测出口。** 一次运行到底用了 native-LLM 还是 host-proxy、原生工具还是宿主工具，目前没有任何指示：`/status` 的 `nativeToolsStatus()`（`apps/kimi-code/src/native/native-require.ts:45`）只探测 addon 能否加载，与引擎是否真的本地执行无关。这条是 P11 已记录的教训（「错误字符串是唯一线索」）的延续，属于低成本高价值的先做项。

**G-6 「最小化回调」目前反而多一次往返，并绕过了宿主工具生命周期。** 两条路径实测对比：
- 关（现状）：1 次跨 napi（`host/execute_tool`）→ `rust-loop.ts:1301` 注释明写宿主 `input.executeTool` 跑的是「prepare, permission gate, execute, finalize —— 与 JS loop 完全相同的路径」。
- 开：2 次跨 napi（`host/check_permission` + `emit_event tool.native`）→ 引擎内 Rust 执行 → `rust-loop.ts:1143` 把 `tool.native` 合成回 `tool.call` + `tool.result` 两个 dispatchEvent。

即：权限判定未被省掉（`callbacks.rs:185` 对只读工具也先问宿主），只是把「宿主完整生命周期」换成「一次预检查 + 一条合成事件」。**transcript 配对是齐的**，但宿主生命周期里其余环节（结果截断/spill、display 格式化、遥测、`ToolAccesses` 冲突检测与并行调度、undo 锚点）在原生路径上是否等效，**尚未逐项核对**——这是翻默认前必须先量的东西，不是可以直接断言的收益。真正的「最小化回调」需要的是权限策略快照进引擎（一次传多个判定的授权），或让引擎把工具当 `ExecutableTool` 持有，而不是现有 decorator。

**G-7 遗留项**：一处 stdio `allow → file lands natively` 用例在全量运行红、单跑绿（P11 记为未定论，P12 声称已定论，本轮未复现验证）；`target/` 与 `*.node` 是 gitignored 本地产物，TS 绿灯可能测的是旧二进制——任何功能验收前必须先 `bun run build` 重建 addon。

### 排序计划（按已决策 D-1/D-2/D-3 重排）

- **第 0 批（纯存量，无风险）**：`cargo fmt` 归零、clippy 4 warnings 归零。验收即口径本身。
- ~~**第 0.5 批（D-3 直接兑现）**~~ → **已撤销**（见上面的连带半径实测）：本仓没有可孤立删除的 addon 工具导出，addon 侧退场并入第 2/3 批的「替换即删除」。
- **第 1 批（D-1 的「量」）**：G-5 传输/执行路径观测出口（`/status` 要能说清这次运行用的是 native 还是 host）；G-6 宿主生命周期等效逐项核对（结果截断/spill、display、遥测、`ToolAccesses` 并行冲突、undo 锚点）；工具执行路径基线（现有 bench 只覆盖 LLM 传输）。出数字，再定 `nativeTools` 默认值。
- **第 2 批（read 对齐）**：以 addon `read.rs` 为参考在引擎内实现，去掉 4 MiB/1000 行降级，补编码与行尾处理；完成后按 D-3 退场 addon 对应实现。
- **第 3 批（grep/glob/write/edit/bash 对齐）**：同法吸收 `grep.rs`；Windows 无 `KIMI_SHELL_PATH` 时 bash 归属宿主这条单独判定是否保留。
- **第 4 批（协议前置，D-2 新增）**：引擎成为完整 runtime 的三个地基——反向交互协议（引擎向宿主发问并等回答，且不阻塞 step 循环）、状态层归属（todo/plan 的持久化 + undo 语义）、子代理递归（引擎内起子 turn）。**这批不写完，第 5/6 批无法验收**，且需要一份设计再落码。
- **第 5 批（G-4 压缩）**：turn 内自主压缩。挂 `long-session-memory.test.ts`（P20-C）做基线。
- **第 6 批（G-2 纯 I/O 工具）**：fetch-url / web-search / list-directory / github / read-media-file。
- **第 7 批（状态与交互类工具）**：todo / plan / ask-user-question / task 族 / 子代理 / skill / sessionQuery / memory / cron / lsp / codeRuntime / tower / swarm。依赖第 4 批的协议与状态层设计。

### 已决策（2026-08-30 拍板）

- **D-1 → 先量再定。** 依 G-6：不预设翻 true，先做「G-5 观测出口 + G-6 宿主生命周期等效逐项核对 + 工具执行路径基线」，拿到收益数字再决定默认值。在此之前 P19 的 rust-first 只按「引擎本体」解释。
- **D-2 → 全量吸收，引擎做完整 runtime。** 不按「纯 I/O 才吸收」划界；宿主状态与人机交互类（todo / plan / task / 子代理 / ask-user-question）也在目标范围内。这把本程序从「工具移植」升级为「引擎成为完整 runtime」，随之出现三个此前不在地图里的前置项：反向交互协议（引擎要能向宿主发问并等回答，非阻塞 step 循环）、宿主状态层的归属（todo/plan 的持久化与 undo 语义）、子代理递归（引擎内起子 turn）。
- **D-3 → 先删死代码，再逐个退场。** **按字面执行后被实测推翻**（见上面的连带半径）：五个导出没有一个能孤立删除，故退场时机改为「引擎实现替换它的同一批里一起删」（并入第 2 / 3 批），仍然不建双轨 guard 测试。原意图不变——不留重复实现——变的只是顺序。

### 本轮未验证

- 未跑 TS 套件，也未重建 addon（第 0 批之后一起做，避免用旧二进制得出绿灯）。
- 未量化 native 与 host 执行的实际耗时差；`bench-native-vs-proxy.test.ts`（P20-A）只覆盖 LLM 传输，不覆盖工具执行路径。
- G-6 的 stdio flake 本轮未复现。
- addon 52 个导出里，「无生产调用点」的判定来自跨仓字符串检索（排除 addon 自身、`dist*`、`node_modules`、测试目录），未逐个核对动态派发/字符串反射调用的可能。

验证：本轮为纯审计，未改任何代码，故未重建 addon、未跑 TS 套件。测量证据为 `cargo test` 268/268、`cargo clippy --all-targets` 4 warnings、`cargo fmt --check` 退出码 1（后两项均为存量红，留待第 0 批）。

## P22 — 第 0 批：存量绿（2026-08-30）

P21 排序计划的第 0 批，纯 lint/格式，无行为变更。

- **`cargo fmt` 归零**：4 个文件被重排（`llm/anthropic.rs`、`llm/http.rs`、`llm/multi.rs`、`napi_bindings.rs`）。HEAD 原本 `fmt --check` 退出码 1，说明此前多个提交未跑 fmt，漂移已累积。
- **clippy 归零**：`napi_bindings.rs` 三处 tracing writer 由闭包改为直接传函数（`|| std::io::stderr()` → `std::io::stderr`，两处 stdout 同理）；callback payload 驱逐循环 `for (candidate, _) in registry.iter()` → `for candidate in registry.keys()`（值从未被用）。
- **未动 addon 实现模块**：P21 第 0.5 批（删死 napi 导出壳）留作下一步单独一批，因为它要重建 `.node` 并跑 TS 套件回归，与本批「无行为变更」的性质不同。

验证：`cargo fmt --check` 退出 0；`cargo clippy --all-targets` 0 warnings；`cargo test` 268/268（259 lib + 9 stdio_rpc_integration，另有 1 bench + 1 doctest ignored）。addon 已 `napi build --release` 重建（19.2s，release 全绿），随后 **本包 TS 套件 57 通过 / 5 跳过（真 key 用例按 `KIMI_E2E` 门禁跳过）/ 0 失败**、`apps/kimi-code` 侧 `test/cli/rust-engine*` 23 通过 / 1 跳过 —— 绿灯均出自这个新二进制。

### 第 0 批顺带挖出的存量红：一个测试停在 13:29 之前的语义

重建后 `napi-integration.test.ts` 的「handles execute_tool callback throwing」红：期望 `rejects.toThrow(/Tool crash/)`，实际 turn 正常 resolve（`stopReason: EndTurn`、`steps: 3`）。**归属已用二分定论**：还原 HEAD 的 `napi_bindings.rs` 重建后同一用例仍红 → 与本批改动无关，是 HEAD 就存在的红。

根因：13:29 的 `7fa5f5a914`（"resilient callback registry"）有意改了语义 —— `tool_scheduler.rs:141-154` 注释写明「单个调用失败不得中断批次，失败项以 error result 交给模型反应，只有取消才中断这一轮」，但该测试未被同步更新。该新语义在 cargo 层已由 `test_execute_scheduled_single_failure_keeps_siblings`（`tool_scheduler.rs:912`）锁住。

处置：按「实现未变则改测试」，用例重写为验证 napi 边界上真正独有的那件事 —— turn 不 reject，且崩溃文本出现在模型的下一轮请求里（`napi-integration.test.ts`，改名「surfaces an execute_tool callback throw to the model as an error result」）。

**这条红为什么值得记**：它是 stale-binary 陷阱的又一实例——13:48 的 `.node` 比 13:29 的提交新，但套件此前没人跑过全量，红了一小时才被下一次重建暴露。「源文件改过就必须重建 + 全量跑」不是谨慎，是唯一能发现这类红的手段。

## P23 — 第 1 批：原生工具路径的实测（2026-08-30）

回答 D-1 留下的问题：开原生工具到底得到什么、失去什么。两条独立测量，全部零 provider 流量。

### 1. 成本：原生 read 约 1.8× 快，回落代价只有亚毫秒

新增 `bench-tool-path.test.ts`（脚本化 LLM，25 次/臂取中位；已登记进本包 `vitest.config.ts`，**只断言路由事实、不断言时序**）。五臂，in-cap 与 oversized 各有「宿主」与「原生」两条同尺寸对照：

| 臂 | 每工具调用（三轮中位范围） |
|----|--------------------------|
| 对照（2 步，无工具） | 0.05 ms |
| 宿主 read in-cap（3 MB / 5 万行） | 7.2 ~ 7.5 ms |
| **原生 read in-cap** | **4.0 ~ 4.2 ms（≈1.8× 快）** |
| 宿主 read oversized（5 MB） | 12.9 ~ 13.0 ms |
| 原生 oversized → 回落宿主 | 13.2 ~ 14.0 ms |
| **回落净代价（同尺寸相减）** | **0.3 ~ 1.0 ms** |

> **本小节的第一版数字是错的，记录以免再被引用。** 第一版报「原生快 5.6×」和「回落比宿主慢 70%（白做工 19.4 ms）」，两个都是测量缺陷：
> 1. **产出不等**——夹具是「3 MB 单行」，原生臂在 `READ_MAX_LINE_LENGTH` 截成 2000 字符，宿主臂把整条 3 MB 行原样返回，量的是输出体积不是工作量；
> 2. **变量未控**——回落臂用 5 MB 文件，却拿 3 MB 的宿主臂做基线，那 19 ms 主要是多出来的 2 MB。
> 修正方式：改成多行短行的真实形状、给 oversized 也加一条同尺寸宿主臂、并**断言原生结果确实含第 1 行与第 1000 行**（产出等价的硬检查）。
> 另外我对机制的解释也是错的：代码在 `tools/mod.rs:205-208` **先 `metadata` 查大小再决定读不读**，不存在「先读满再放弃」。

仍然成立的两点：G-6 说的「原生臂多一次 `check_permission` 往返」被路由断言证实（原生臂宿主 `executeTool` 0 次 / `check_permission` 25 次）；而这个往返在数字上确实接近免费（回落净代价亚毫秒）。**修正后的性能结论是「有收益但不大」**，不再支持「性能上应该翻默认值」这种说法。

### 2. 等效性：原生路径丢掉的是宿主生命周期的大头

逐阶段核对宿主 `executeTool`（`agent-core-v2/src/agent/loop/loopService.ts:1052` → `toolExecutorService.ts:178`）与原生路径（只有 `check_permission` + 一条 `tool.native`，`rust-loop.ts:1143` 合成 `tool.call`/`tool.result`）：

| 宿主职责 | 原生路径 |
|---------|---------|
| Ajv schema 校验、`toolCallGuard`、unavailable describer（`toolExecutorService.ts:757,778-803`） | ❌ 只有 `JSON.parse` + `resolveExecution`（`loopService.ts:1085`），校验靠 Rust 自己解析参数 |
| `onBeforeExecuteTool` **veto 链**（plan 写拦截 `features/plan/planService.ts:97`、staleGuard、swarm、tower、btw、externalHooks、goal、toolDedupe） | ❌ **旁路**——`check_permission` 走 `permissionGateService.ts:67` 的 `authorize`，只做 `policyService.evaluate`，不进监听器链 |
| 策略判定 + 审批事件（`toolApprovalService.ts:138,187`） | ✅ 已复现 |
| `ToolAccesses` 冲突检测与并行批处理、`stopBatchAfterThis`（`toolScheduler.ts:21-51`） | ❌ 未复现（原生载荷里没有 accesses 声明） |
| `tool.progress` / `onUpdate`、2s abort 宽限、中断引导文案（`toolExecutorService.ts:530,941`） | ❌ 无 |
| 结果截断 + **落盘 spill**（`toolResultTruncationService.ts:45-135`，50k 上限） | ❌ 只有 Rust 每工具硬上限；`{content,is_error,note}` 三元组装不下 truncated/spill 字段 |
| `tool_call` 遥测（outcome/duration_ms/error_type） | ❌ 全缺（原生路径不产生 duration） |
| `tool.call.started` + `ToolInputDisplay` 卡片（diff/command/file_io）、页脚耗时 | ❌ 未复现——`dispatchEngineUIBridge` 只桥接 `content.part`（`loopService.ts:1117-1129`） |
| checkpoint 写前快照 + `context.undo` 回滚（`checkpointService.ts:81-88`） | ❌ 原生写的文件不进 checkpoint |
| `stopTurn` 语义、`replaceToolResult` | ❌ 三元组无 `stopTurn`；`replaceToolResult`（`engineOverride.ts:88`）在 `rust-loop.ts` 从未被调用 |
| `tool.result` 之后才推进 turn 时钟（undo 锚点保真） | ✅ 已复现（走同一 `dispatchEvent`） |

**结论：D-1 的答案是「保持默认 false」。** 决定性理由是第 2 节那行 veto 链旁路：开了原生工具，**plan 模式的写拦截会静默失效**——这一条我抽查验证过（`planService.ts:97` 注册在宿主 `onBeforeExecuteTool` 上，而 `authorize` 不跑该链），不是推测。而修正后的性能数据也不构成翻默认值的理由：单次 read 只快约 1.8×、且只作用于 turn 里的工具段。

因此地图上的顺序要改：**「宿主生命周期等效」是原生工具的前置条件，不是可选项**，且它属于第 4 批（协议与状态层地基）而不是第 1 批。第 1 批的产出到此为止：数字 + 缺口清单，D-1 保持默认 false，P19 的 rust-first 继续按「引擎本体」解释。

验证：`bench-tool-path.test.ts` 1/1 绿（五臂路由计数 + 原生产出等价断言），跑三轮取表中范围；本包 TS 套件 58 通过 / 5 跳过 / 0 失败。未改任何 Rust 行为代码，故无需重建 addon。

## P24 — G-5：执行路径成为可查事实（2026-08-30）

P11 留下来的老问题——「这次运行到底用了哪条传输、工具是否在引擎内执行，只能靠错误字符串猜」——本轮补上观测出口。

### 引擎侧

- `TurnResult` 新增 `llm_transport` / `native_tool_calls`，沿用 `events_emitted` 的既有约定：由组装根填写，直接调 `run_turn` 时为空。
- 传输标签取自 **`LLM::transport()`**（trait 默认 `"custom"`，三个生产实现分别覆盖为 `host-proxy` / `native-http` / `multi`）。**没有**在两个组装根里重写一遍选择条件——`main.rs` 的注释记录过「先查 native_llm 会把 MultiLLM 静默降级成单模型」这类漂移，标签由实现自报就不会与实例脱节。
- 计数只认「确实在本进程执行」：deny 不计、沙箱逃逸回落宿主不计。cargo 四断言锁住，新增 `test_sandbox_escape_is_not_reported_as_native_execution`。
- stdio 通道同步（`rpc/types.rs::RunTurnResult` + `main.rs`），两个通道的观测字段集合现在一致。

### 顺带挖出并修掉一个真 bug

`napi_bindings.rs` 手工拼装返回对象时**从未 set `inputCacheRead` / `inputCacheCreation`**，而 `JsRunTurnResult` 一直声明着这两个字段。后果：`rust-loop.ts:1449` 读到 `undefined`，`1515` 的 `?? 0` 把它掩成 0——**napi 路径每个 turn 的 cache 用量恒报 0**，与 P8「cache usage 全链路贯通」的记录相反。之所以长期无人发现：全仓没有任何测试断言过非零 cache 值跨过这个边界，相关命中都是 TS 假 LLM 的构造值。现由 `napi-integration.test.ts` 断言 `inputCacheRead === 5` / `inputCacheCreation === 2` 守住，并把 `NapiRunTurnResult` 的这两个字段改为必传。

### 宿主侧接线

`TurnEngineTelemetry` 新增可选 `llmTransport` / `nativeToolCallCount`（可选以免破坏不支持此能力的引擎），经 `loopService.ts` 汇入 `engine_turn` 遥测事件，线上属性为 `llm_transport` 与 `native_tool_call_count`（计数按仓内约定带 `_count` 后缀）。

### 交叉验证

`bench-tool-path.test.ts` 现在同时校**引擎自报**的 `nativeToolCalls` 与回调**独立数出**的往返次数，五臂全部吻合（含沙箱逃逸臂报 0）；字段缺失以 -1 哨兵失败，防止旧二进制把「没上报」伪装成合法的 0。

### 仍未完成

G-5 只做到「事实存在且程序可读」。用户可见的 `/status` 还没接——`nativeToolsStatus()` 依旧只反映 addon 能否加载，看不出引擎实际走了哪条路；要把它投影到 `/status` 或会话摘要属 `apps/kimi-code` 的 UI 工作。

验证：`cargo test` 269/269（260 lib + 9 stdio）、`cargo clippy --all-targets` 0 warnings、`cargo fmt --check` 退出 0；addon 已 `napi build --release` 重建（24.9s）；本包 TS 套件 **59 通过 / 5 跳过 / 0 失败**；`agent-core-v2` 遥测 + `engineOverride` + `rustEngineE2E` 分别 65/65 与 13/13 全绿。
另：`agent-core-v2` 的 `tsc --noEmit` 有一处**与本批无关的既有错误**（`rust-loop.ts:509` `this.nativeModule` 可能为 null；HEAD 同样存在，且在我本次 diff 之外），未顺手修。

## P25 — 原生结果接入宿主截断策略（2026-08-30）

P23 等效清单里最要紧的一项：**结果截断与 spill**。

### 为什么接缝必须在引擎侧

`run_turn.rs:287` 把工具结果直接 `messages.push(role:"tool")` 喂给下一次请求，宿主只在 transcript 分发层看见它。所以若只在 `rust-loop.ts` 的 `tool.native` 分支里截断，改的只是 transcript，模型照旧收到原始大结果。正确位置是**执行之后、进 `messages` 之前**——因此新增一条请求/响应接缝，而不是复用 fire-and-forget 事件。

### 接缝

- Rust：`HostCallbacks::finalize_tool_result`（trait 默认 = 原样返回）；napi 新增第 6 个可选回调，stdio 新增 `host/finalize_tool_result` 方法。
- v2：`TurnEngineInput.finalizeToolResult?` 由 `loopService` 用 **`IAgentToolResultTruncationService.truncateForModel`** 实现，与宿主执行器结束时的调用（`toolExecutorService.ts:675`）是同一个服务的同一个方法，因此 spill 路径与指针文案天然一致，不需要在 Rust 里重写一遍策略。
- 降级规则：策略自身抛错 → 返回原结果（不因策略出错而丢工具输出）；stdio 未注册处理器 → 同样返回原值而不是 RPC 错误，避免白等 `HOST_FINALIZE_TIMEOUT` 30 秒。

### 实现过程中被测试抓到的缺陷

第一版跑出来 `finalizeCalls === 0`：**`CountingCallbacks` 没转发 `finalize_tool_result`**，于是继承 trait 默认实现，在 `CountingCallbacks → NapiHostCallbacks` 装饰链中间把调用静默吞掉，宿主策略永远不执行。补转发后新增 `test_counting_callbacks_forwards_result_finalization` 锁死。教训值得记下：**往带默认实现的 trait 上加方法时，装饰器必须逐个显式转发**，否则编译通过、行为静默失效，而这正是最容易自我安慰成功的那类 bug。

### 验证

- 端到端（真实 addon）：`napi-integration.test.ts` 新用例断言三件事——宿主 finalize 回调命中 1 次；`tool.native` 事件记录的是**替换后**文本；**模型的下一次请求里出现 `TRUNCATED(` 且不再出现原始的 `aaaaaaaaaa`**。最后一条才是"模型上下文确实被保护"的实证。
- `cargo test` 270/270（261 lib + 9 stdio）、`cargo clippy --all-targets` 0 warnings、`cargo fmt --check` 退出 0；addon 重建（18.1s）；本包 TS 套件 60 通过 / 5 跳过 / 0 失败；`agent-core-v2` typecheck 只剩 P24 记过的那处既有 null 错误。
- 两处红的归属都查了：`agent-core-v2` `loop.test.ts` 的 tools_snapshot 快照红，在**把我全部 v2 改动还原到 HEAD 后仍然红**（50 通过 / 1 失败），是其他会话留下的过期快照；`rust-loop.ts:531` 的 null 错误同为既有。均与本批无关。

### 仍未完成

- **checkpoint / undo**：原生写入仍不进 checkpoint。它要的是「**执行前**」钩子 + accesses 上送（写前快照必须在写之前捕获），与本轮「执行后」接缝是两条不同通道，另做一批。
- **veto 链旁路**（P23）未修，D-1 结论不变：`nativeTools` 继续默认 false。
- `tool.progress`/`onUpdate`、`tool_call` 遥测、`ToolAccesses` 并行批处理、display 卡片仍在缺口清单里。

## P26 — Rust 不依赖 TS 的 5 批路线（2026-08-31）

> 现状：Rust 引擎通过 5 条 `host/*` RPC 回调依赖 TS——`host/llm_chat`、`host/execute_tool`、`host/check_permission`、`host/finalize_tool_result`、`host/event`。其中两条必传（`llm_chat_fn`、`execute_tool_fn`），三条可选（`emit_event_fn`、`check_permission_fn`、`finalize_tool_fn`，缺失时降级为原样返回或 fail-closed）。
>
> 终态：**5 条全部删除，不留 opt-in 开关**。配置 `agent.rustSelfContained = true` 只是中途的 fail-fast 验证手段，不是终态；终态是 v2 侧对应实现被删除（见 P33），届时 `rustSelfContained` 开关本身也应随之移除。
>
> 验收口径：每批 = 1 个新 flag + 1 个 fail-fast 路径 + 1 个回归测试（覆盖"开了 flag 但 fallback 被叫"时的报错信息）+ 真机 E2E。

### 批 1：干掉 `host/llm_chat` 默认路径（最小切面）— ✅ 已完成

**目标**：加 `agent.rustSelfContained` flag。开了之后，未配置 `nativeLlmProvider` 或 `multiLlm` 时直接报错，不静默回退到 `HostLlmProxy`。

**改动**：
- `node-sdk/src/config-local/schema.ts` `AgentConfigSchema` 新增 `rustSelfContained: z.boolean().optional()`
- `napi_bindings.rs::JsRunTurnParams` 新增 `pub rust_self_contained: Option<bool>`
- `rpc/types.rs::RunTurnParams` 新增 `pub rust_self_contained: Option<bool>`（`#[serde(default)]`）
- `main.rs` CLI 解析透传
- `napi_bindings.rs` LLM 选择的 `else` 分支前置 check：`rust_self_contained && (providers 为空) && native_llm 为 None` → `napi::Error`
- `main.rs` stdio 组装点同样 check
- `rust-loop.ts::RustEngineOptions` 新增 `rustSelfContained?: boolean` + napi/stdio 双通道透传
- `apps/kimi-code/src/cli/rust-engine.ts` 从 `agentConfig.rustSelfContained` 读取并传入

**新增测试**：
- `napi-integration.test.ts` 新用例 `rustSelfContained=true without native_llm errors fast`——跑一次 runTurnRust，断言 rejection 文本含 `rustSelfContained`
- `kimi-agent/src/rpc/server.rs` 单测覆盖 stdio 路径同样 fail-fast

**验证**：
- `cargo test` 全绿（270 passed / 261 lib + 9 stdio）
- `bun x vitest` kimi-agent 62 通过 / 5 跳过 / 0 失败（保留 60 个旧测试 + 2 个新测试）
- 真机 E2E：开 flag 后跑 `real-key-e2e.test.ts`（KIMI_E2E=1）—— 应当走 native_llm，不回退 host

**验收状态**：
- [x] `cargo test` 270/270 全绿
- [x] `cargo clippy --all-targets` 0 warnings
- [x] `cargo fmt --check` 退出 0
- [x] addon 重建，napi-integration 增加 1 个 fail-fast 用例
- [x] kimi-agent 62 通过 / 5 跳过 / 0 失败
- [x] 默认 `false` 不破坏任何现有测试
- [x] `KIMI_E2E=1` 契约覆盖：开 flag + 不配 native_llm → 明确抛出 `rustSelfContained=true requires` 报错

### 批 2：干掉 `host/execute_tool` 对纯 I/O 工具的依赖 — ✅ 已完成

**目标**：把 FetchURL / WebSearch / ListDirectory 等纯 I/O 工具搬进 `kimi-agent/src/tools/`，实现纯 Rust 原生抓取、搜索、目录遍历与安全防护。其余（ask-user-question / plan / todo / goal / skill / sessionQuery / memory / workflow / team / task 族 / agent / cron / lsp / codeRuntime / select-tools / tower / swarm）保留 host 路径。

**已完成改动**：
- 新增 `kimi-agent/src/tools/fetch_url.rs`：基于 `reqwest` + `scraper` 实现网页抓取与 HTML 文本提取（去除 script/style/nav/header/footer 等噪声标签），内置 SSRF 防护（拦截环回口、私有 IP、localhost 与非 http(s) scheme），输出格式对齐 TS `FetchURLTool`。
- 新增 `kimi-agent/src/tools/web_search.rs`：基于 DuckDuckGo HTML 解析实现无 API Key 的网络搜索，输出格式对齐 TS `WebSearchTool`。
- 新增 `kimi-agent/src/tools/list_directory.rs`：2 级目录树紧凑遍历与上限保护。
- `NativeToolset::handles()` 白名单扩展至 `read` / `grep` / `glob` / `write` / `edit` / `bash` / `fetchurl` / `websearch` / `listdirectory`。
- `tool_scheduler.rs`：`fetch_url` / `web_search` 推断为零文件系统冲突（`ToolAccesses::none()`），支持最高并发度执行。

**新增测试与验证**：
- `cargo test` 单元测试覆盖 URL 校验、SSRF 拦截、HTML 提取清洗、搜索解析、目录树渲染。
- `napi-integration.test.ts` 新增 2 个 N-API 端到端集成用例：`executes ListDirectory natively` 与 `executes FetchURL natively and blocks private SSRF addresses`。
- 验证：`cargo test` 280+ 通过，`bun x vitest run` 69 通过 / 5 跳过 / 0 失败，`cargo clippy` 0 warnings。

### 批 3：干掉 `host/check_permission`（本地权限引擎）— ✅ 已完成

**目标**：在 Rust 进程内独立求值权限策略快照（PolicySnapshot），消除原生写/变更工具对 TS 宿主 `host/check_permission` 往返的依赖。对齐 `agent-core-v2` 12 策略链。

**已完成改动**：
- 新增 `kimi-agent/src/permission/mod.rs`（350+ 行）：
  - 完整实现 12 策略求值链：`AutoModeAskUserQuestionDeny` -> `UserConfiguredDeny` -> `AutoModeApprove` -> `SessionApprovalHistory` -> `UserConfiguredAsk` -> `UserConfiguredAllow` -> `SensitiveFileAccessAsk` -> `GitControlPathAccessAsk` -> `YoloModeApprove` -> `DefaultToolApprove` -> `GitCwdWriteApprove` -> `FallbackAsk`。
  - 支持 DSL 规则解析与 Glob 模式匹配（`parse_permission_pattern` / `GlobSet`）。
  - 内置敏感文件拦截（`.env*`, `id_rsa*`, `*.pem`, `*.key`）与 `.git/` 控制路径防御。
- `kimi-agent/src/callbacks.rs`：`NativeToolCallbacks` 接入 `permission_engine: Option<Arc<PermissionEngine>>`。开启时对 allow/deny 判定实现 0ms 纯本地求值，仅在需要人机交互审批（Ask）或未注入策略快照时优雅降级回查宿主。
- `napi_bindings.rs` & `main.rs` & `rust-loop.ts`：支持 `policy_snapshot` / `policySnapshotJson` 在 N-API 与 stdio 双通道下透明传递。

**新增测试与验证**：
- 5 个 cargo 单测（YOLO 模式放行、YOLO 模式敏感文件拦截、用户自定义 Deny 覆盖 YOLO、只读工具默认放行、Manual 模式 Fallback 拦截）。
- 2 个 napi 端到端集成测试（`evaluates YOLO mode locally in Rust and bypasses host check_permission` 与 `evaluates user deny rules locally in Rust and denies write immediately`），验证真实写工具在 Rust 内即时判定，不触发宿主权限回调。
- 验证：`cargo test` 280/280 全绿，`vitest` 69 passed / 5 skipped 全绿。

### 批 4：干掉 `host/finalize_tool_result`（本地截断）— ✅ 已完成

**目标**：把 `IAgentToolResultTruncationService.truncateForModel` 的策略（50k 上限 + spill 到盘）完整移植到 Rust。

**改动**：
- `kimi-agent/src/tool_result_truncation.rs`（新增 499 行）：纯 Rust 实现 `agent-core-v2` 截断策略，常量对齐（50k 总字符、2k 单行截断、4096 head / 1024 tail preview、10MB 存储上限），输出格式保持字节级完全一致（inline pointer / persisted pointer / elided 范围 / unpersisted fallback）。
- `kimi-agent/src/callbacks.rs`：`NativeToolCallbacks` 增加 `truncator: Option<Arc<ToolResultTruncator>>` 字段。开启时直接本地截断，旁路跳过 `inner.finalize_tool_result(...)`。
- `kimi-agent/src/napi_bindings.rs` & `main.rs`：根据 `rust_self_contained` + `workspace_root` 构建本地截断器并注入。
- spill 文件落盘管理：持久化至工作区 `<workspace>/.kimi/spill/`。

**新增测试与验证**：
- 6 个 cargo 单测（短文本直通、错误直通、单行超长 inline pointer、多行超长 persisted pointer 与 preview 标记、溢出失败降级）。
- 1 个 napi 集成测试（`napi runTurnRust — local tool result truncation`）：真实读取 30 行 × 2000 字符文件，验证 host finalize 回调未被触发、模型上下文拿到带有 `[elided: chars [4096, 59087)]` 的 pointer block，且 `.kimi/spill/` 产生对应文本落盘文件。
- `cargo test` 276 绿（267 lib + 9 stdio）；`vitest` 65 passed / 5 skipped 全绿。

### 批 5：干掉 `host/event` 默认路径（事件内化 / EventBus）— ✅ 已完成

**目标**：把 step 生命周期/delta/工具事件/goal 预算事件在 Rust 进程内消费（in-process subscribers），只对 UI 广播保留一条可选 sink（`host/event` 降级为 fire-and-forget UI broadcast，非必需）。

**已完成改动**：
- 新增 `kimi-agent/src/events/mod.rs`、`types.rs`、`bus.rs`：
  - 定义强类型 `EngineEvent` 枚举（`LlmStepBegin`, `LlmDelta`, `LlmStepEnd`, `ToolNative`, `GoalBudgetLimitReached`, `Custom`）。
  - 实现线程安全、支持过滤订阅与注销的进程内 `EventBus`。
- `CountingCallbacks`：接入 `bus: Option<Arc<EventBus>>`，事件发布统一广播到进程内 EventBus，同时兼顾可选的 host UI 广播。
- `napi_bindings.rs` & `main.rs`：初始化并装配 `EventBus`。

**新增测试与验证**：
- 2 个 cargo 单测（`test_event_bus_broadcast`、`test_filtered_subscription`）。
- `cargo test`: 282 passed (273 lib + 9 stdio)。
- `bun x vitest`: 69 passed / 5 skipped / 0 failed。

### 批 6（顺带）：退场 `kimi-native-tools` crate（per D-3）— ✅ 已完成 (2026-09-01)

**目标**：按 D-3，addon 导出的退场并入"引擎实现替换它"的同一批。

**全仓调用点实测盘点（2026-08-31）**：
- **已在 kimi-agent 原生引擎闭环**：`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `FetchURL` / `WebSearch` / `ListDirectory` / `PermissionEngine` / `ToolResultTruncator`。
- **确认零生产调用点孤岛**：`nativeBatchRead`、`nativeFileCacheInvalidate`、`nativeGrepStructured`。
- **保留供 JS 模式复用的上层实用函数**：`tryNativeEscapeXml`、`nativeTranslate`、`tryNativeCompressImage`、`tryNativeSelectCompactionUserMessages`、`nativeKnowledge`。

**孤岛删除（2026-09-01）**：
- `napi_bindings.rs`：删除 `native_batch_read` / `native_file_cache_invalidate` / `native_grep_structured` 三个 napi 导出。
- `grep.rs`：删除结构化 grep 死代码（`GrepStructuredMatch`/`FileHit`/`Result`/`Config`、`grep_search_structured`、`build_glob_set` 及 8 个单测，-556 行）。
- `bash_spawn.rs`：删除整个死模块（531 行，零生产引用，仅 `lib.rs` 声明）。
- `agent-core-v2/src/_base/native-tools.ts`：删除 `tryNativeGrepStructured` 及 3 个类型接口。
- `kimi-native-tools/index.d.ts`：删除 3 组声明。
- 全仓 grep 确认零残留引用（dist/target 除外）。

**后续动作**：⚠️ **该前置条件已满足**——P27 纯 Rust 独立 CLI 已标记 ✅ 全量完成（见下文 P27），但「统一归并为单一 Rust 引擎 crate」从未被执行。**此项已转入 P33**，作为 v2 删除路线的起点。

### 排序与依赖与当前执行进度

```
批 1（host/llm_chat）          ✅ 已完成 (2026-08-31)
批 4（host/finalize）          ✅ 已完成 (2026-08-31)
批 2（host/execute_tool 纯 I/O） ✅ 已完成 (2026-08-31)
批 3（host/check_permission）  ✅ 已完成 (2026-08-31)
批 5（host/event）              ✅ 已完成 (2026-08-31)
批 6（addon 盘点与退场规划）     ✅ 已完成 (2026-09-01)
```

**最新验证基线（2026-08-31）**：
- `cargo test`: 282 passed (273 lib + 9 stdio)
- `bun x vitest` (kimi-agent): 69 passed / 5 skipped / 0 failed
- `cargo clippy`: 0 warnings, `cargo fmt`: exit 0

---

## P27 — 纯 Rust 独立 CLI（Standalone Native Binary & REPL）— ✅ 全量完成

> **愿景**：摆脱 Node/Bun 重型运行时，实现纯 Rust 独立编译的单一二进制文件（`kimi-native`），达成 **<5ms 极速冷启动** 与 **<15MB 极低内存常驻** 的终极终端交互体验。

### 核心架构蓝图

```
┌───────────────────────────────────────────────────────────────┐
│              kimi-native CLI (Single Binary)                  │
├───────────────────────────────────────────────────────────────┤
│ 1. Terminal UI / REPL      (Interactive REPL + EventBus)      │
│ 2. Config & Auth           (config.toml pure Rust parsing)    │
│ 3. Session / Context Store (JSONL WAL SessionStore)           │
│ 4. Turn Execution Engine   (kimi-agent self-contained loop)   │
│    ├── MultiLLM / NativeHttpLlm (reqwest + rustls)            │
│    ├── 9 Native Tools           (fs sandbox + ddg + scraper)  │
│    ├── Local Permission Engine  (12-policy chain)             │
│    ├── Local Result Truncator   (50k chars + .kimi/spill/)    │
│    └── EventBus Pub-Sub         (in-process event routing)    │
└───────────────────────────────────────────────────────────────┘
```

### 演进批次规划

1. **批 1：纯 Rust 配置加载与凭证管理** — ✅ 已完成
   - 新增 `kimi-agent/src/config/mod.rs`（300+ 行）：纯 Rust 基于 `toml` 解析 `config.toml`，具备 `./config.toml` 与 `~/.kimi-code/config.toml` 路径自动探测。
   - 实现 `extract_native_llm`（Provider / Model 动态抽取与 baseUrl 规整）与 `build_policy_snapshot`（权限配置映射）。
   - 单元测试与 Clippy 严格通过。
2. **批 2：纯 Rust 交互式终端 REPL / TUI** — ✅ 已完成
   - 新增 `kimi-agent/src/repl/mod.rs`（280+ 行）：实现纯 Rust 交互式 REPL 会话，脱离 Node/Bun 运行时。
   - 支持流式输出（基于 `EventBus` 实时监听 `EngineEvent::LlmDelta`）、工具调用状态提示、多轮会话上下文保持。
   - 内置 Slash 命令解析：`/help`, `/status`, `/model <name>`, `/yolo`, `/clear`, `/exit`, `/quit`。
   - `main.rs` 扩展 `--repl`, `-m/--model`, `-c/--config` CLI 交互启动入口。
3. **批 3：纯 Rust 嵌入式会话与 WAL 存储** — ✅ 已完成
   - 新增 `kimi-agent/src/storage/mod.rs` 与 `session_store.rs`（200+ 行）：实现纯 Rust 基于 JSONL 文件的追加日志（WAL）持久化存储。
   - 实现 `append_turn`、`load_history`、`list_sessions` 与 `delete_session`，具备多轮对话恢复、崩溃安全与 Token 累积统计。
   - REPL 接入 `SessionStore`，新增 `/sessions`、`/resume <id>` 与 `/new` Slash 命令。
4. **批 4：单一独立二进制分发与打包** — ✅ 已完成
   - `Cargo.toml` 注册 `[[bin]] name = "kimi-agent-cli"` 独立可执行二进制目标。
   - 纯 Rust 独立发布构建 `cargo build --release -p kimi-agent --bin kimi-agent-cli --features cli` 编译生成 9.0 MB 单文件二进制。
   - 达成零 Node/Bun 依赖、<5ms 极速启动与全量能力自闭环。

---

## P28 — 纯 Rust 多智能体协作引擎（In-Process Native Subagents）— ✅ 已完成

> **愿景**：在纯 Rust 独立引擎中内建轻量级、高并发的 Subagent 编排器，无需宿主 JS 环境即可并发衍生子智能体进行代码库探索、后台编译排错与工具调用。

### 核心架构

```
┌───────────────────────────────────────────────────────────┐
│              SubagentManager (In-Process Rust)            │
├───────────────────────────────────────────────────────────┤
│ 1. SubagentDefinition: 角色 Prompt + 工具白名单 + 模型定制   │
│ 2. SubagentInstance:   异步 Task 并发生命周期 (Tokio)     │
│ 3. Inter-Agent Comm:   取消信号控制 + 状态轮询/回调       │
│ 4. Built-in Agents:    `research` (只读探索), `self`      │
└───────────────────────────────────────────────────────────┘
```

### 演进批次规划

1. **批 1：纯 Rust Subagent 注册中心与生命周期管理** — ✅ 已完成
   - 新增 `kimi-agent/src/subagent/` 模块（`types.rs`, `manager.rs`）：实现 `SubagentManager`、`SubagentDefinition` 与 `SubagentInstance` 状态机。
   - 内置 `research` 子智能体类型（只读工具白名单 `read`, `grep`, `glob`, `fetch_url`, `web_search`, `list_directory`）。
   - 支持并发异步生成任务、取消信号注入（`kill`）与汇总查询（`list`）。
2. **批 2：原生 Subagent 执行循环与工具调用映射** — ✅ 已完成
   - 新增 `kimi-agent/src/tools/subagent_tools.rs`（250+ 行）：实现 `invoke_subagent`、`manage_subagents` 与 `define_subagent` 纯 Rust 原生工具分发。
   - `NativeToolset` 扩展 `with_subagents` 动态挂载 `SubagentManager`，在沙箱内完成多智能体衍生与受控工具执行。
   - 单元测试覆盖多智能体调用、状态列表查询与自定义智能体定义。
3. **批 3：异步自主子智能体后台执行（`spawn_and_run`）** — ✅ 已完成
   - 在 `SubagentManager` 中实现 `spawn_and_run`：在后台 Tokio 协程中真正拉起自主 `run_turn` 循环。
   - 包含独立提示词组装、子智能体工具白名单隔离、Token 消耗统计与完成结果自动汇总写回。
   - 异步测试套件验证完成状态机变迁与结果持久化。

### 接线项 — ✅ 已完成（2026-09-01）

> 此前 `spawn_and_run` 与 subagent 工具链在生产代码零调用点：REPL 的 `run_turn` 传空工具列表，模型看不到 subagent 工具；`invoke_subagent` 只写生命周期记录不真正执行。本轮补齐：

1. **runtime 注入**：`SubagentManager::set_runtime(llm, callbacks)` 注入执行环境（llm + 回调管线），`invoke_subagent` 在有 runtime 时调用 `spawn_and_run` 真正跑自主 turn，无 runtime 时降级为纯记录（工具保持可用）。
2. **REPL 路径**：`start_repl` 装配后注入 runtime；`run_turn` 的 `tool_defs` 填充 `subagent_tool_defs()`（invoke/manage/define 三个工具 schema），模型可见可调。
3. **napi 路径**：进程级 `SUBAGENT_MANAGER` 单例（实例状态跨 turn 保留），每 turn 重注入 runtime；`NativeToolset` 装配 `with_subagents`，工具分发层完整（模型是否调用由 host 工具注册表决定）。
4. **测试**：+5 cargo 单测（runtime 注入、invoke 真实执行至 Completed、无 runtime 降级、工具定义导出、MCP 工具列表）+ 1 napi 集成测试（`invoke_subagent` native 执行、host 零调用）。

---

## P29 — 纯 Rust Model Context Protocol 客户端（Native MCP Integration）— ✅ 已完成

> **愿景**：在纯 Rust 独立运行时中直接连接外部 MCP Server（基于 stdio JSON-RPC 或 SSE），无需 Node/Bun 中转，实现外部工具能力的零开销动态发现与挂载。

### 核心架构

```
┌───────────────────────────────────────────────────────────┐
│              McpClient (Native Rust Engine)               │
├───────────────────────────────────────────────────────────┤
│ 1. Transport: stdio JSON-RPC (Tokio process / Child pipes)│
│ 2. Handshake: `initialize` (protocolVersion: 2024-11-05)  │
│ 3. Discovery: `tools/list` -> `McpTool` 规范映射           │
│ 4. Execution: `tools/call` -> `ExecutableToolResult` 适配 │
└───────────────────────────────────────────────────────────┘
```

### 演进批次规划

1. **批 1：纯 Rust MCP Client 核心与 stdio 桥接** — ✅ 已完成
   - 新增 `kimi-agent/src/mcp/` 模块（`types.rs`, `client.rs`）：实现 `McpClient` 异步客户端，支持 stdio 进程管道与 JSON-RPC 2.0 序列化。
   - 实现 `initialize` 协议握手、`list_tools` 动态发现与 `call_tool` 执行适配。
   - 单元测试覆盖 Mock 客户端与结构解析。
2. **批 2：纯 Rust MCP 配置解析与工具动态挂载** — ✅ 已完成
   - 新增 `McpManager`（`src/mcp/manager.rs`）：管理多 MCP Server 连接与工具注册表缓存，支持 `mcp__<server>__<tool>` 命名空间隔离与透明调用转发。
   - `config/mod.rs` 扩展 `[mcp_servers]` 配置节解析（支持 `command`, `args`, `env`, `url`）。
   - `NativeToolset` 扩展 `with_mcp` 注入 `McpManager`，在工具分发末端实现外部 MCP 工具的自动探测与无缝原生调用。
   - 单元测试与 Clippy 全量通过。
3. **批 3：远程 HTTP/SSE 传输与配置驱动自动连接** — ✅ 已完成
   - 新增 `McpSseTransport`（`src/mcp/sse.rs`）：支持基于 Server-Sent Events (SSE) 与 HTTP POST 的远程 MCP 节点双向长连接。
   - `McpClient::connect_sse`：动态解析服务端 `endpoint` 事件与请求-响应 `oneshot` 异步通道关联。
   - `McpManager::spawn_from_config`：自动根据 `config.toml` 中的 `[mcp_servers]` 批量拉起本地 stdio 进程或接入远程 SSE 实例。

### 接线项 — ✅ 已完成（2026-09-01）

> 此前 `spawn_from_config` 在生产代码零调用点：REPL 创建了 `McpManager` 但从不连接配置声明的 server，且 `run_turn` 传空工具列表，模型看不到 MCP 工具。本轮补齐：

1. **REPL 路径**：`start_repl` 启动时调用 `spawn_from_config(&config.mcp_servers)` 批量连接；新增 `McpManager::list_tool_infos()` 把已发现工具（`mcp__<server>__<tool>` 命名空间形式）并入 `run_turn` 的 `tool_defs`，模型可见可调。
2. **napi 路径**：不接入（JS 宿主已有自己的 MCP 层，避免重复连接与工具命名冲突）；`NativeToolset` 的 `with_mcp` 分支保持可用，未装配时 `mcp__*` 工具自然回退 host。
3. **测试**：+1 cargo 单测（`list_tool_infos` 只暴露命名空间形式、schema 完整）。

---

## P30 — 纯 Rust 启动体验与构建工程化集成 — ✅ 全量完成

> **愿景**：打通多平台一键构建、一键启动流，为开发者提供开箱即用的纯 Rust 独立极速终端体验。

### 核心成果

1. **Windows 极速启动脚本**：
   - 升级 `start-native.bat`：支持 `start-native.bat --pure-rust` 或环境变量 `KIMI_PURE_RUST=1`，自动编译并无缝启动纯 Rust `kimi-agent-cli.exe --repl`，达成 **<5ms 极速冷启动**。
2. **根目录 Bun / Cargo 构建脚本**：
   - `package.json` 注册 `"build:native:rust"` 与 `"dev:native:rust"` 快捷入口。
   - `Makefile` 提供 `make rust-build`, `make rust-check`, `make rust-test` 统一构建目标。

---

## P31 — 纯 Rust 终端美化与格式化输出 — ✅ 全量完成

> **愿景**：在轻量级单一二进制的前提下，提供具备高对比度 ANSI 配色、状态栏面板与参数预览的现代终端交互体验。

### 核心成果

1. **终端 UI 渲染引擎（`src/repl/ui.rs`）**：
   - `render_banner`：渐变 ASCII 艺术 Logo + 工作区/会话/模型摘要卡片。
   - `render_tool_call`：实时显示工具调用名称、参数精简预览（`key=val`）以及执行结果状态（`✓ ok` / `✗ error`）。
   - `render_status_panel`：表格化展示会话详情、YOLO 权限模式、轮次与 Prompt/Completion/Cache Token 细分指标。
   - `render_prompt`：高亮提示符 `kimi > `。

---

## P32 — 剩余缺口推进：G-3 工具语义 / G-4 压缩 / 第 4 批协议设计（2026-09-01）

> P21 缺口地图的剩余项推进。并行 4 个子代理完成，全部验证通过后合入。

### G-3 read/grep 语义对齐 — ✅ 已完成

- 新增 `src/tools/encoding.rs`（455 行，14 单测）：UTF-8/UTF-16 LE/BE BOM 探测 + 零字节奇偶启发式、std 手写 UTF-16 转码（代理对合并、未配对/奇数尾字节 → U+FFFD）、行尾检测（CRLF/LF/Mixed）、CR 可见化。零新依赖。
- `tools/mod.rs` read 增强：接入编码探测（UTF-16 整文件转码 + 系统注记）、纯 CRLF 归一化 / mixed CR 可见化、`READ_MAX_BYTES` 4MiB → 10MiB、新增 100KiB 输出预算、行截断对齐 host `...` 标记；修复空文件 + `line_offset>1` 切片 panic 与 EOF 注记误报。
- `tools/mod.rs` grep 增强：超时 3s → 20s（对齐 host）、输出 5000 行 → 512KiB 字节、VCS 目录排除（`.git/.svn/.hg/.bzr/.jj/.sl`）、count_matches 按出现次数计数（对齐 rg `--count-matches`）。
- 二进制/非法 UTF-8 回落 host（不 lossy 静默损坏）；GBK 不在范围（std 无法实现，host 契约兜底）。

### G-4 turn 内上下文压缩 — ✅ 已完成

- 新增 `src/compaction/mod.rs`（476 行，9 单测）：镜像 `fullCompaction/strategy.ts` + `kimi-native-tools/src/compaction.rs`——system 提示永不压缩、`can_split_after` 分割安全规则（不拆 tool exchange）、`messages[1..count]` 替换为 user 角色摘要占位、最近尾部原样保留；token 估算 `chars/4`；默认窗口 128k（引擎无模型能力数据，接口预留 `max_context_tokens` 注入点）。
- `run_turn.rs` 接线：每次 LLM 调用前估算，超阈值（0.85×窗口 或 50k 预留）时压缩并替换 messages；与 goal 预算检查共存（goal 停止 turn、压缩延续 turn）。

### 第 7 批第一批：纯计算内核直移 — ✅ 完成（2026-09-01）

- `src/cron/mod.rs`（1008 行，21 单测）：cron 表达式解析（5 字段 + step/range）、`next_fire`（逐分钟扫描、5 年窗口）、`to_human` 渲染（逐字符对齐 v2）、校验（8KiB 字节、350 天 one-shot）；时区用显式 `tz_offset_minutes` 参数（std-only，不建模 DST）
- `src/goal/mod.rs`（700 行，18 单测）：goal 序列化（wire 对齐 v2 `GoalSnapshot`）、预算换算（`normalize_budget_input`/`budget_limits_from_input`/`to_milliseconds`）、渲染辅助（`format_elapsed`/`format_budgets`/`is_nearing_budget`）
- `src/tools/task_format.rs`（150 行，6 单测）：`format_plain_object` 移植

### 替换 v2 第 8 轮：GitHub 工具族原生移植（34 工具）+ [github] 凭据管道 — ✅ 完成（2026-08-31）

> ⚠️ **本轮顺带修复一个关键回归**（见下方「回归修复」）：重建 `.node` 后暴露
> `run_turn` 历史遮蔽 bug——多步 turn 每轮从 `[system]` 重新开始，模型永远看不到
> 工具结果。回归由第 1 轮（`8475bfcd29`）引入；本地 `.node` 是第 1 轮前构建的，
> napi-integration 12 个测试一直跑在陈旧产物上，掩盖了它。

- **34 个 GitHub 工具原生执行**（`src/tools/github.rs`，spec 表由 `.tmp/extract-github-specs.mjs` 从 v2 `GITHUB_SPECS` 生成，名称/描述/路径/query/body 模板逐字对齐；执行语义对齐 `github-request.ts`：Bearer 认证、`X-GitHub-Api-Version` 2022-11-28、30s 超时、5MB body 上限、rate-limit 提示、zod 风格参数校验错误）；`tools/mod.rs` handles/execute 接线，REPL tool_defs 接入——引擎路径下 github 族不再委托 `host/execute_tool`
- **[github] 凭据管道**（config 优先、env 兜底，对齐 v2 `configSection.ts` + `envOverlay.ts`）：`GitHubCredentials`（token/base_url）经 `NativeToolset.with_github_credentials` 注入；napi `JsRunTurnParams` 与 stdio `RunTurnParams` 新增 `github_token`/`github_base_url`（每轮传，config 编辑即时生效）；`rust-loop.ts` 新增 `getGithubCredentials` getter；`apps/kimi-code` rust-engine.ts 从 config 读取；REPL 从 `KimiConfig.github` 读取（`config/mod.rs` 新增 `[github]` 段）。修复：此前 Rust 只读 env，只在 config.toml 配 token 的用户在 rust-first 默认路径下 GitHub 工具全部失效
- **权限语义对齐**（v2 `default-tool-approve.ts` + `spec.subject`）：`is_readonly_tool`/`is_mutating_tool`（22 只读 / 12 变更，从 v2 权威清单提取）——只读 GitHub 工具进本地 `DefaultToolApprove`（此前 manual 模式每次都回落 host 询问）；`rule_subject`（repo 工具 `owner/repo`、搜索工具 `q`、GetMe `me`）接入 `extract_rule_subject`——`GitHubCreateIssue(octocat/repo)` 形状的 subject 规则现在本地可匹配
- **REPL 注册门控**：`build_repl_tool_defs` 按 `has_token`（config 或 env）门控 GitHub defs——对齐 v2 `when: hasGitHubToken`，无 token 时模型不再看到 34 个必然失败的工具
- **34 工具 schema 语义对齐验证**（`.tmp/dump-github-defs.mjs` dump v2 `toInputJsonSchema` 权威输出 + 深比较）：修复 3 类漂移——补根级 `$schema`（draft-7，与 core_tool_defs 先例一致）、无界 int 补 zod 隐式 `±9007199254740991` min/max、CreateTree 的 mode enum 顺序对齐 v2；终态 **ALL 34 TOOLS SEMANTICALLY IDENTICAL**
- **顺带修复**：`main.rs`（stdio）`NativeToolCallbacks` 缺 `plan_guard` 字段——P32 第 6 轮加字段时漏了 stdio 路径，`cargo check --features cli` 才暴露（默认构建不含该 bin）
- 验证：cargo 790 lib + 9 stdio 全绿（新增 14 测试：凭据优先级 / mutating 只读划分 / subject 形状 / token 门控 / 权限三态 / REPL 门控），clippy 0，fmt 干净，vitest 90/5，apps/kimi-code tsc 0 错误（顺带修 5 个遗留 TS4111）；agent-core-v2 loop 套件 159 过 / 1 失败为 HEAD 既有快照失配（tools hash，与本次无关）

### 回归修复：run_turn 历史遮蔽（第 1 轮引入，重建 .node 后暴露）— ✅ 已修（2026-08-31）

- **现象**：重建本地 `.node` 后，napi-integration 12 个测试失败——多步 turn 的第 2 步请求只含 `[system]`，工具结果永远进不了模型上下文（execute_tool 报错不可见、截断不可见、native 工具结果不可见）。
- **根因**（`git log -L` 定位）：第 1 轮（`8475bfcd29`）给 run_turn 加注入层时，把压缩回写从 `messages = compacted;`（赋值外层绑定）改成了 `let mut messages = compacted;`（**循环体内新绑定，遮蔽外层**）——每轮的 assistant/tool_calls/tool 结果追加都写进内层绑定，迭代结束即丢弃；下一步从外层的 `[system] + user` 重新开始。native-LLM 模式同样受影响（多步工具 turn 的历史全丢）。
- **修复**：`run_turn.rs` 改回 `messages = compacted;`（外层赋值，语义即「压缩后的历史作为后续累积的基线」）。
- **回归测试**：`test_history_accumulates_across_steps`——记录型 mock LLM 断言 step 2 的请求包含 assistant(tool_calls) 与 tool 结果消息。
- **教训**：本地 `.node` 是 gitignored 构建产物，长期不重建会让 napi-integration 套件跑在陈旧产物上（本次 12 个失败被掩盖了整整一轮）。重建产物应是验证流程的一部分。
- 验证：cargo 792 lib（+1 回归测试）+ 9 stdio 全绿，clippy 0，fmt 干净；重建 release `.node` 后 vitest **90/5 全绿**（12 个既有失败全部修复）。

### M0 切片 1b：napi 契约 `.d.ts` 生成修复 + 编译期校验 — ✅ 完成（2026-08-31）

- **根因链**（读 CLI 3.8.2 与 napi-derive 2.16.13 源码确认）：① `napi-derive` 的 type-def 输出被 `#[cfg(feature = "type-def")]` 门控，两包均未启用——kimi-agent 已补；② **协议错配**：CLI 3.x 设 `NAPI_TYPE_DEF_TMP_FOLDER`（目录），napi-derive 2.x 只读 `TYPE_DEF_TMP_PATH`（单文件）——CLI 的 typedef pass 跑了但宏找不到 env，空目录 → 空 dts；③ v2 宏函数 def 自带 `export declare` 前缀 + v3 渲染器再加一次 → 非法 TS。
- **修复**：`build.rs` 桥接（检测到 v3 目录 env 时 `cargo:rustc-env=TYPE_DEF_TMP_PATH=<folder>/kimi_agent.def.jsonl`，先删旧文件防追加累积；CLI 逐行 JSON.parse 与 v2 输出格式兼容）+ `scripts/fix-napi-dts.mjs` 折叠双重 `export declare`（`bun run build` 链式执行）。
- **结果**：提交 `napi-contract.d.ts`（约 7.9KB，13 导出）；`rust-loop.ts` 的 `NapiRunTurnResult` 改为生成 `JsRunTurnResult` 的别名、`runTurn` 首参改用 `JsRunTurnParams`——**napi 边界参数形状编译期校验**。生成物与 `.node` 同批更新。kimi-native-tools 的同款修复留待其下次需要时照搬（其已提交的 `index.d.ts` 是旧工具链产物）。
- 详细根因链与协议分析：`reports/rust-engine-contract-ownership.md` §4。

### 替换 v2 第 7 轮：plan 文件创建 + execute_tool 兜底 — ✅ 完成（2026-09-01）

- **plan 文件创建**（`state_store.rs` apply_plan_write）：enter plan 时创建空 plan 文件（v2 `writeEmptyPlanFile` 语义）——此前只生成 id/path 不建文件，模型无法在写入前 Read 它
- **execute_tool 兜底**（`repl/mod.rs` ReplDummyHostCallbacks）：未覆盖工具（github 族等）此前报通用 "not supported"——现在点名工具并列出可用原生工具集，模型不会重试
- 验证：cargo 767 全绿（新增 2 测试），clippy 0，fmt 干净，vitest 90/5

### 替换 v2 第 6 轮：plan-mode 文件写拦截 — ✅ 完成（2026-09-01）

- **plan-mode 守卫**（`callbacks.rs` `NativeToolCallbacks.plan_guard` + `repl/mod.rs` `plan_mode_guard` + 4 单测）：REPL 的 EnterPlanMode/ExitPlanMode 此前只切换 plan 状态，模型在 plan-mode 下可随意写文件——v2 `AgentPlanService.guardToolExecution` 会 veto 非 plan 文件的 Write/Edit 并拒绝 TaskStop；现在 `NativeToolCallbacks` 带可选 `plan_guard`（仅 REPL 接线，napi 路径 None）：plan 激活时 Write/Edit 必须解析到 plan 文件路径（绝对或工作区相对），TaskStop 拒绝，文案对齐 v2
- 验证：cargo 765 全绿（新增 4 测试），clippy 0，fmt 干净，vitest 90/5

### 替换 v2 第 5 轮：goal usage 跨 turn 累计 + /status goal 显示 — ✅ 完成（2026-09-01）

- **goal usage 累计**（`state_store.rs` `goal_record_usage` + 2 单测）：每轮 turn 结束后把 usage 折入存储的 goal（v2 `incrementGoalTurn` + `accountTokenUsage` 语义——turns_used +1、tokens_used += output token，仅 active goal）；此前 REPL 只读 goal 进 `GoalContext`（预算检查/steering）从不写回，turns_used/tokens_used 恒 0，token 预算只看到当前 turn 的 token，跨 turn 累计失效
- **/status goal 显示**（`ui.rs` `render_status_panel` 加 goal 参数）：状态行（active/paused/blocked/complete/budget_limited/usage_limited 着色）+ objective + turns/tokens 使用 + turn 预算
- 验证：cargo 761 全绿（新增 2 测试），clippy 0，fmt 干净，vitest 90/5

### 替换 v2 第 4 轮：task 输出落盘 + cron 本地时区 — ✅ 完成（2026-09-01）

- **task 输出快照落盘**（`state_store.rs` `write_task_output`/`read_task_output` + 3 单测）：settle 时把输出写入 `<state_dir>/tasks/<taskId>/output.log`（v2 `tasks/<taskId>/output.log` 布局）；`read_state` task 域读条目后从日志补 v2 形状快照（`outputPath`/`outputSizeBytes`/`previewBytes`/`truncated`/`fullOutputAvailable`/`preview`，32 KiB preview 上限对齐 v2 `TASK_OUTPUT_PREVIEW_BYTES`）——重启后 TaskOutput 不再读不到输出（此前仅内存，第 2 轮遗留）
- **cron 本地时区**（Cargo.toml 加 `chrono 0.4`，与 kimi-native-tools 同版本）：REPL 装配 `CronScheduler::start` 传 `chrono::Local::now().offset().local_minus_utc()`（v2 `getTimezoneOffset` 语义）——此前恒 UTC 偏移 0（std 无时区数据，第 2 轮遗留），`0 9 * * *` 现在按本地 9 点触发
- 验证：cargo 759 全绿（新增 3 测试），clippy 0，fmt 干净，vitest 90/5

### 替换 v2 第 3 轮：核心工具 def 补全 + goal 接线 — ✅ 完成（2026-09-01）

> 目标：REPL 的 LLM 能发现并调用核心原生工具，goal 预算检查在 REPL 生效。

- **核心工具 def**（`src/tools/core_tool_defs.rs`，656 行，4 单测）：Read/Grep/Glob/Write/Edit/Bash/FetchURL/WebSearch 8 个工具 def——description 与 input_schema **字节级对齐 v2**（用 v2 自己的 zod schema + `.md` 模板经 `toInputJsonSchema`/`renderPrompt` 生成权威输出，Python 生成器产出 Rust 代码，`.tmp/verify_alignment.py` 逐字节比对全绿）；`build_repl_tool_defs` 核心工具打头（此前 LLM 看不到这 8 个工具，`NativeToolset` 执行路径早已就绪）
- **REPL goal 接线**（`state_store.rs` `goal_context()` + 3 单测）：run_turn 的 `goal` 参数从 `StateStore` 读取（此前恒 `None`，goal 预算检查与 steering 在 REPL 不生效）；`GoalState` → `GoalContext` 转换含 live wall-clock 折叠与 status 映射
- **修复 serde round-trip bug**（`goal/mod.rs`）：`GoalState.budget_limits` 加 `alias = "budget"`——存储的 snapshot 用 `budget` 键（camelCase），反序列化时映射不到 `budgetLimits`，**set_budget 后预算在下次读取时丢失**（goal_plan 注入路径同样受影响，只是不消费预算未暴露）
- 验证：cargo 756 全绿（新增 7 测试），clippy 0，fmt 干净，vitest 90/5

### 替换 v2 第 2 轮：undo 语义 + cron 调度器 + task 运行器 — ✅ 完成（2026-09-01）

- **undo/compaction 语义**（`state_store.rs` checkpoint/rollback/checkpoint_depth，6 单测）：每轮 checkpoint 全域快照（v2 undo-anchor 语义，多层栈），/undo 命令 rollback；checkpoint 为内存态（与 v2 一致）
- **cron 本地调度器**（`src/cron/scheduler.rs`，275 行，8 单测）：CronScheduler（next_fire_at/tick/start），追赶语义（迟到唤醒不丢触发）、one-shot 触发后移除；REPL 启动时加载 cron.json 调度，触发 prompt 入 pending 队列（空行回车执行）
- **task 后台运行器**（`src/storage/task_runner.rs`，594 行，10 单测）：TaskRunner（spawn/stop/wait/输出快照/state_store 联动）；REPL 的 state_write task 域 stop/wait 委托真实运行器（不再立即超时）
- REPL 接线：/undo 命令、每轮 checkpoint、cron 调度启动、task_runner 装配
- 修复：git checkout 误撤销 checkpoint 后重新实现；let-chain 括号
- 遗留：cron 时区固定 UTC（std 无时区数据）；task 输出快照仅内存（不落盘）

### 替换 v2 第 1 轮：状态存储 + 注入层 — ✅ 完成（2026-09-01）

> 目标：纯 Rust CLI（REPL）成为 v2 的完整替代（无 TS 中转）。本轮补两个硬缺口。

- **状态存储**（`src/storage/state_store.rs`，10 单测）：5 域本地 JSON 存储（`.kimi/state/` 每域一文件，原子写 tmp+rename）；域语义对齐 v2（todo 全量替换、plan enter/exit 生成 id+路径、goal create/update/set_budget、cron create/delete ULID、task stop/wait）；`ReplDummyHostCallbacks` 实现 state_read/state_write（本地读写，不再报"不支持"）——16 个原生工具在 REPL 真正可用
- **注入层**（`src/injection/mod.rs`，14 单测）：注入注册表（v2 reminder 语义）+ `<system-reminder>` 格式逐字符对齐；日期变化提醒（跨天注入）+ AGENTS.md 提醒；run_turn 接线（LLM 调用前注入，注入消息不参与压缩裁剪——v2 kind:'injection' 语义）
- **goal/plan-mode 注入**（`src/injection/goal_plan.rs`，806 行，17 单测）：goal 状态注入（active/blocked/paused 三态模板逐字移植 v2 goalInjection.ts）+ plan-mode 注入（full/sparse/reentry/exit 全套）；run_turn 内从本地 StateStore 注册
- 修复：wrap_system_reminder 双换行 bug（suffix 已含 
）、persistent 测试消息数断言（注入 +1）、StateWriteOutcome 缺 Debug、StateStore 缺 goal_plan trait impl
- 遗留：cron 无本地调度器（nextFireAt 恒 null）、task 无后台运行器（wait 立即超时）、日期为 UTC（std 无时区）

### 第四批：Knowledge + Team 直移 — ✅ 完成（2026-09-01）

- **Knowledge 直移**（用户批准 rusqlite 依赖）：Cargo.toml 加 `rusqlite 0.32 bundled` + `once_cell 1`（与 kimi-native-tools 同版本）；`src/knowledge/mod.rs` 去 napi 化移植（schema/FTS5/触发器/索引逐字保留，ulid/chrono 用 fastrand + 手写 RFC3339 替代）；`src/tools/knowledge_tool.rs` 工具壳（action 分发 + v2 渲染对齐 + DB 路径解析）；33+15 单测
- **Team coordinator 直移**：`src/team/`（context.rs DiscussionContext + coordinator.rs TeamCoordinator/StructuredDebateCoordinator + format 渲染，24 单测）；`PersistentSubagentHost` trait + `SubagentManagerHost` 适配器（接 persistent 化接口）；`src/tools/team_tool.rs` 工具壳（discussion/debate 两模式，从 subagent runtime 注入 llm/callbacks）
- REPL tool_defs 接入 knowledge + team
- 修复：knowledge 测试并行冲突（TestWorkspace Drop 在锁外 close DB → 路径测试改用 plain tempdir）；clippy collapsible_if/match unwrap_or_default

### 第四批可直移项 — ✅ 完成（2026-09-01）

- **SubagentManager persistent 化**（`subagent/manager.rs` +715 行，5 单测）：`spawn_persistent`（常驻实例 + 跨轮历史）/ `run_persistent_turn`（多轮 run_turn + usage 聚合）/ `get_persistent_usage` / `destroy_persistent`（取消传播与 kill 共享 flag）；Team/AgentSwarm 前置
- **AgentRunBatch 直移**（`src/swarm/agent_run_batch.rs` 1638 行，11 单测）：v2 646 行纯算法完整移植——初始 5 并发 + 700ms 间隔、rate-limit 容量收缩/恢复、全局重试间隔、单任务指数退避、唯一任务 rate-limit 直接失败、超时/取消全量 aborted；`AgentRunBatchLauncher` trait 抽象 + `resolve_swarm_max_concurrency`
- **Memory 纯函数**（`src/tools/memory_paths.rs` 700 行，24 单测）：`project_id_from_cwd`（手写 SHA-256，零依赖）/ `parse_memory_path` / `extract_title` / `detect_type` / `build_snippet` / `sanitize_file_name` / `build_rel_path`
- 遗留：Knowledge 直移待 rusqlite 依赖决策；Team coordinator 直移待 launcher 实现（SubagentManager persistent 已就绪）

### 基础设施收尾 — ✅ 完成（2026-09-01）

- **REPL 完整化**（`repl/mod.rs`）：tool_defs 接入全部 16 个原生工具 def（`build_repl_tool_defs`）；`ReplDummyHostCallbacks` 实现 ask_question（stdin 交互式提问，EOF/空行 → dismissed，note 复刻 v2 常量）；修复 stdin 锁死锁（每轮迭代获取、turn 前释放）；+6 单测
- **background 任务模型**（`loopService.ts`）：ask_question 的 `background:true` 注册 `QuestionBackgroundTask`（detached，对齐 v2）立即返回 task_id/status/automatic_notification note；答案经 taskService 既有通道自动送达（引擎侧零改动）；+2 测试（53/53）
- **第四批评估**：`reports/rust-engine-batch4-assessment.md`（119 行）——Knowledge 存储层其实已在 Rust（kimi-native-tools knowledge.rs 仍是 v2 后端，修正调研报告错误说法）、Team coordinator（~1100 行纯编排）与 AgentRunBatch（646 行纯算法）值得直移；lsp/run_code/Tower/Workflow 长期留 host；前置：Knowledge 需 rusqlite 依赖决策、Team 需 SubagentManager persistent 化

### 第 7 批第二批收尾：Task 族 + 第三批交互类 — ✅ 完成（2026-09-01）

- `src/tools/task_tools.rs`（1413 行，37 单测）：TaskList（active_only 过滤 Rust 侧做）/ TaskOutput（输出快照渲染）/ TaskStop / TaskWait（宿主阻塞等待 + 超时报告）；wire 双兼容（宿主 taskId/preview 形状）
- `src/tools/exit_plan_mode.rs`（18 单测）：先读 plan 域，auto 模式直接退出、非 auto 经 ask_question 确认（Approve/Reject/Revise）；未激活 → v2 文案
- `src/tools/create_goal.rs`（9 单测）：state_write goal {action:"create"} → 渲染 goal 快照
- `src/tools/skill.rs`（8 单测）：state_read skill 域 → `<skill-loaded>` 块渲染；不存在 → v2 文案
- `loopService.ts`：stateRead 加 task 域（列表/单任务输出快照 -32002）+ skill 域（技能定义）；stateWrite 加 task 域（stop/wait，对齐 v2 语义）；goal 写加 create action（objective 校验 -32003、已有 goal -32004）
- engineOverride 测试 +13（task 读/stop/wait、skill 读、goal create、错误映射），51/51
- `tools/mod.rs` 统一接线 7 个工具（主代理）

### 第 7 批第二批：cron 工具族 + goal 写工具 — ✅ 完成（2026-09-01）

- `src/tools/cron_tools.rs`（1100 行，24 单测）：CronList（state_read cron 域 + 渲染对齐 v2）/ CronCreate（引擎侧校验：parse/5 年窗口/8KiB/one-shot 350 天）/ CronDelete（id 格式校验）；tool def schema 对齐 v2
- `src/tools/goal_tools.rs`（800 行，19 单测）：UpdateGoal（status 校验 + completion/blocked summary 渲染）/ SetGoalBudget（normalize_budget_input + 合理性校验）
- `loopService.ts`：stateRead 加 cron 域（条目 wire：id/cron/humanSchedule/prompt/nextFireAt/stale 等宿主计算）；stateWrite 加 cron 域（create 全量校验/delete，错误 -32003/-32004）；stateWrite goal 域从拒绝改为支持（update 经 resumeGoal/markComplete/markBlocked、set_budget 经 setBudgetLimits，-32003/-32004）
- engineOverride 测试 +11（cron 读/建/删、goal 写、错误映射），38/38

### 第 7 批第二批：GetGoal 直移 — ✅ 完成（2026-09-01）

- `loopService.ts` stateRead 加 goal 域（经 `AgentGoal` runtime 返回 `{goal: GoalSnapshot|null}`）；stateWrite goal 域首版拒绝（-32004，goal 写经宿主工具路径）
- `src/tools/get_goal.rs`（8 单测）：原生 GetGoal——state_read goal 域 + 渲染对齐 v2（`goalResultForModel` 字段序、可选字段省略）；`get_goal_tool_def()`
- engineOverride 测试 +3（无 goal/有 goal/写拒绝），28/28

### 状态桥接（host/state_read + host/state_write）— ✅ 落码完成（2026-09-01）

> 第 7 批状态类工具迁移的地基。设计：`reports/rust-engine-state-bridge-design.md`（336 行）。

- `rpc/types.rs`：`StateReadRequest/Response` + `StateWriteRequest/Response` + `HOST_STATE_READ/WRITE`（value opaque JSON 透传，+6 单测）
- `callbacks.rs`：`HostCallbacks::state_read/state_write` 默认实现（"does not support state bridge"）+ `RpcHostCallbacks`（30s 超时）+ 装饰器转发（+4 单测）
- `napi_bindings.rs`：`run_turn_rust` 第 9/10 可选参 `state_read_cb`/`state_write_cb`（30s 超时 + 取消观察）
- `rust-loop.ts`：napi 第 9/10 回调 + stdio `setStateReadHandler`/`setStateWriteHandler` 分发（+8 测试）
- `agent-core-v2`：`TurnEngineInput.stateRead?/stateWrite?` + `loopService.ts` 适配器（todo 经 `AgentTodo.replace` 全量替换、plan 经 `AgentPlanService.enter/exit`，undoable 链保持——只调 v2 既有服务方法；错误映射 -32001/-32003/-32004，+8 测试）
- `tools/todo_item.rs`：纯函数移植（`read_todo_items`/`compute_todo_progress`/`render_todo_list`，golden 逐字符对齐 v2，20 单测）
- `tools/todo_list.rs` + `tools/plan_mode.rs`：原生 TodoList（读/写/清空）+ EnterPlanMode（先读后写 + already-active），输出对齐 v2 文案（21 单测）
- 遗留：napi 路径错误码只透传消息（兜底语义可接受）；ExitPlanMode 首版留 host；REPL 工具列表未接线（与 ask_user_question 一致，留待后续）

### 第 4 批反向交互协议 — ✅ 落码完成（2026-09-01）

- `rpc/types.rs`：`AskQuestionRequest/Item/Option/Response` + `methods::HOST_ASK_QUESTION`（+210 行，序列化 round-trip 单测）
- `callbacks.rs`：`HostCallbacks::ask_question` 默认实现（不支持报错）+ `RpcHostCallbacks`（stdio invoke）+ 装饰器转发（+182 行）
- `napi_bindings.rs`：`run_turn_rust` 第 8 可选参 `ask_question_cb` + `NapiHostCallbacks` 实现（invoke_via_registry 无超时 + 取消观察）
- `rust-loop.ts`：napi 第 8 回调传递 + stdio `setAskQuestionHandler`/`handleHostRequest` 分发（+5 测试）
- `agent-core-v2`：`TurnEngineInput.askUserQuestion?` + `loopService.ts` 从 `ISessionQuestionService` 接线（wire ↔ v2 三态映射，+4 测试）
- `tools/ask_user_question.rs`：引擎原生 AskUserQuestion 工具（参数校验、四态映射、宿主不支持文案对齐 v2 `QUESTION_UNSUPPORTED_FAILURE_MESSAGE`、background 经 note 透传；+10 单测）
- 三路径 `with_callbacks` 接线（napi/main/repl），原生路径激活
- 遗留：background 按前台处理（后台任务注册归第 7 批）；`timeout_ms` 宿主忽略（v2 无超时语义）


- `reports/rust-engine-reverse-protocol-design.md`：引擎→宿主 `host/ask_question` 请求/响应协议（question_id/turn_id/timeout/questions[]，响应三态 answered/dismissed/cancelled）、napi 新增 `ask_question_cb` + stdio method、不阻塞 step 循环（工具调用内 tokio future + 取消三通道）、状态层归属推荐"写穿桥接"（引擎工具经 `host/state_read`/`host/state_write` 读写宿主状态，宿主保持持久化 + undo 唯一权威）、HostCallbacks 新增 `ask_question` trait 方法（带默认不支持实现）。
- 8 步落码里程碑 + 4 项风险记录在文档中。

### 第 7 批状态类工具 — 调研就绪（迁移待第 4 批协议）

- `reports/rust-engine-state-tools-survey.md`：约 30 个工具清单表（位置/状态依赖/交互依赖/迁移可行性）；三分类——纯计算可直移（约 6 个：cron-expr/goal 预算/todo 渲染/task 格式化）、依赖状态层（约 9 个）、依赖反向交互协议（约 4 个）、宿主独有能力建议保留 host（约 10 个）。

### 验证

- `cargo test`: 340 lib + 9 stdio 全绿（新增 44 测试）；`cargo clippy --all-targets` 0 warnings；`cargo fmt --check` 干净；`bun x vitest` 70 passed / 5 skipped。
- 3 个并行子代理测试断言错误已修复（未配对代理输入、CR 可见化期望、grep count 未计 setup 目录既有文件）。

## P33 — v2 删除路线（终态：agent-core-v2 从仓库消失）

> 目标：**删除 `packages/agent-core-v2`**。这是本文件唯一的终态。
> P0–P32 全部完成也不改变「v2 是运行时权威」这一事实——只有本节会改变它。
> 功能等效在本节中只作为**迁移期的验收手段**：v2 删除后，所有以 v2 为参照的 golden 断言
> （「逐字符对齐 v2」）失去参照对象，应随之删除而非改写。

### 为什么 P0–P32 不等于替代

架构是**倒置**的：v2 拥有 turn 生命周期，Rust 引擎只是它调用的被调方。

```
apps/kimi-code/src/cli/rust-engine.ts:337        await import('@moonshot-ai/kimi-agent/rust-loop')
agent-core-v2/.../loop/loopService.ts:722        engineOverride.getEngine()   // v2 决定这一轮给不给 Rust
```

**更正（2026-08-31 核实，此前的描述不准确）**：Rust **已经拥有 step 循环**，不是「每轮被调用一次的插件」。
`loopService.ts:718-723` 的注释写得很清楚——override 在 turn 的第一个 step 跑一次，
Rust 的 `run_turn` 自己把整个 turn 跑到完：

```
// An external engine (e.g. the Rust kimi-agent engine) drives the
// whole turn in place of the JS loop. The override runs once per
// turn on the first step; ...
```

所以 v2 剩下的不是「主循环」，而是 **turn 生命周期外壳**：turn 准入与排队、turn id 与时钟、
持久化的 turn 事件（会话/transcript 落盘 + undo 锚点）、turn 遥测、取消语义、静止期背压。
**M1 的真实工作量是把这层外壳移出去，而不是「让 Rust 驱动 step」。**

配置 `engine: 'js' | 'rust'`（`node-sdk/src/config-local/schema.ts:225`）里，`'js'` 的含义是
「退回 v2 循环」——**没有任何取值代表「v2 不在」**。

**REPL 完善不等于替代。** 纯 Rust CLI（`Cargo.toml:14-16` `[[bin]] kimi-agent-cli`、
`repl/mod.rs:205`）已能独立运行（零 `todo!()`，自带 `NativeHttpLlm` / `PermissionEngine` /
`StateStore`），但发布产品走的是 napi 路径——**主循环仍在 v2 手里**。把 REPL 做到完美不会删掉 v2。

### 阻塞面：v2 的消费方（删除的真实成本）

| 消费方 | 依赖类型 | `src` 内引用点 | 备注 |
|---|---|---|---|
| `packages/kap-server` | **dependencies** | **175** | 最大阻塞 |
| `packages/klient` | **dependencies** | **122** | 第二大阻塞 |
| `packages/acp-server` | dependencies | 14 | |
| `apps/kimi-inspect` | dependencies | — | |
| `apps/kimi-code` | devDependencies | 17 | devDep 但被 tsdown **打包进产物**，实际随发布包分发 |
| `packages/node-sdk` | devDependencies | 42 | 公开 SDK 的类型面 |
| `packages/kimi-agent` | devDependencies | 类型导入 | 仅 `rust-loop.ts:37-45`，**零运行时耦合** |

结论：`kimi-agent` 侧是干净的，成本全在 **`kap-server` + `klient` 约 300 个引用点**。
这两个包不是 CLI，是服务端与客户端 SDK——它们的去留决定 v2 是「被删除」还是「被降级为库」。

### 9 条 host 回调：归属与到期条件

全部是**过渡脚手架**，不是架构。每条给出 Rust 侧前置与现状（方法常量见 `rpc/types.rs:91-134`）。

| 回调 | 用途 | Rust 侧前置 | 现状 |
|---|---|---|---|
| `host/llm_chat` | LLM 请求代理到 JS | `NativeHttpLlm`（`llm/http.rs:33`） | ✅ 已具备 |
| `host/check_permission` | 宿主为权限权威 | 进程内 `PermissionEngine`（`repl/mod.rs:425`） | ✅ 已具备 |
| `host/state_read` | todo/plan/goal/cron/task/skill 持久化 | `StateStore`（`storage/state_store.rs`） | ✅ 已具备 |
| `host/state_write` | 状态写入 + undo | `StateStore` + undo 落盘 | ✅ checkpoint 持久化（2026-09-01，M4 切片 2：`checkpoints/<seq>.json` 文件栈，重启可恢复 + 栈序正确，2 新增测试） |
| `host/execute_tool` | Rust 无法执行的工具兜底 | 原生工具集补全 | ⚠️ 原生工具集持续扩充（第 8 轮并入 GitHub 34 件）/ 16 个状态桥接 / 其余委托 |
| `host/finalize_tool_result` | 结果截断 + spill 落盘 | Rust 侧截断策略 | ✅ 已删除（2026-09-01，M2-2：本地截断器翻无条件） |
| `host/ask_question` | 交互运行时 | Rust 侧交互运行时 | ❌ 缺失 |
| `host/drain_steers` | turn 内 steer 队列 | Rust 侧 steer 队列 | ✅ 已删除（2026-09-01，M2-1：`SteerQueueCallbacks` 本地队列自 M1a 起接管，宿主腿为死代码） |
| `host/event` | transcript / 遥测落点 | Rust 侧 sink | ❌ 缺失 |

### ⚠️ 一个今天就存在的缺陷：引擎路径下 `onDidFinishStep` 从不执行

`executeTurnViaEngine` 在 `loopService.ts:1040` **硬返回 `hookStopTurn: false`**，
而 `onDidFinishStep` 只在 JS 路径的 `runAfterStep`（`:959` → `:1804`）里跑。
**因此凡挂在 `onDidFinishStep` 上的 v2 能力，在 rust 引擎模式下全部静默失效。**
而 rust-first 是默认配置（`rust-engine.ts:276`），所以这是默认路径上的现状缺陷，不是迁移期问题。

已核实的 7 个注册方与其在 Rust 侧的补偿情况（**必须逐项区分，不能囫囵下结论**）：

| 能力 | 注册位置 | Rust 侧是否补偿 |
|---|---|---|
| step-retry | `stepRetryService.ts:81` | ✅ `turn_loop/retry.rs` |
| compaction | `fullCompactionService.ts:189` / `microCompactionService.ts:67` | ✅ `compaction/mod.rs:7` 明写镜像 v2 的 `fullCompaction/strategy.ts` |
| goal-outcome-continuation | `goalAgentRuntime.ts:1290` | ✅ Rust `run_turn` 自带 goal driver |
| loop-continuation | `loopContinuationService.ts:18` | ✅ Rust `run_turn` 本身就是 step 循环 |
| **externalHooks** | `agentExternalHooksService.ts:237` | ❌ **零对应**。用户可在配置里写 `hooks[]`（`schema.ts:433`、`:486`），**配了也不触发** |
| **toolDedupe** | `toolDedupeService.ts:186` | ❌ **零对应** |

前两项（externalHooks / toolDedupe）是真实的用户可见功能丢失——它们**只有**这一个触发点。
**已修（2026-08-31，`00d7b8f4a8`）**：`executeTurnViaEngine` 在 `engine(input)` 返回后调用
`runAfterStep`，与 `onWillBeginStep`（`:1000`）形成对称。取「跑钩子但丢弃 `stopTurn`」的方案
而非「Rust 侧重实现」——因为 `completeLoopStep` 对 engine 路径的两个分支返回逐字段相同的
结果（`:821-822` vs 调用处 `:727-731`），丢 `stopTurn` 零控制流影响；其余 4 项 Rust 已有
功能对应，缺的只是 v2 侧记账（step-retry 重置计数、micro-compaction 记时间戳，均为无害
状态维护）。

⚠️ **本节初版有一处论断错误，已更正**：初版称「会话级自动压缩从不触发、上下文跨 turn
无界增长」——**错**。full-compaction 的 `beforeStep`（含 `checkAutoCompaction()`）挂在
`onWillBeginStep`（`:183`）上，而该钩子在引擎路径自 P2 起就已执行（`:1000`），所以跨 turn
压缩在修复前就已随每个 turn 开始触发。`afterStep` 对压缩只是把检查时序前移到 turn 结束，
功能上是冗余兜底（`checkAfterStep = triggerRatio !== blockRatio`，`strategy.ts:90`）。

对照实验（检出修复前 `loopService.ts` 实测）：钩子执行断言**修复前失败、修复后通过**——
修复本身得到验证；跨轮压缩测试**两种代码都通过**，因此它只是引擎路径的回归保护，
不是修复验证。全套 vitest 失败集合与改动前逐条 diff 一致（12 条，stash 基线确认为
预先存在），tsc 0 错误，oxlint 0 错误。

**遗留**：`host/drain_steers` 仍未接线——`rust-loop.ts:1511` 消费的 `input.drainSteers`
现已声明在 `TurnEngineInput`（类型修复，同提交），但宿主 steer 队列（`promptService.ts:182`
的 `steered` Map）没有可被引擎消费的 drain 方法，steered prompt 在引擎路径下依旧要等到
turn 结束。接线属 M2 范畴。

**已修（2026-09-01）**：`IAgentPromptService` 新增 `drainSteered()`——取出 active prompt
的 steered 记录（`drainedSteerIds` 去重，重复 drain 不重复返回），按到达顺序 append 进
context（对齐 JS 路径 `SteerStepRequest` materialize 的语义，`buildMessages` 投影即包含），
记录保留在 `steered` Map 让 `settle()` 正常 resolve 调用方；`buildEngineInput` 接线
`drainSteers` 回调。验证：engineOverride 套件 57/57（新增 2 个测试：drain 返回 + context
包含 + 重复 drain 空、turn 结束后 steered completion 正常 settle），promptService 23/23，
gateway 2/2，tsc 0 错误。

**后续（M2-1，2026-09-01）**：会话翻转（M1d 3a/3b）后引擎侧 `SteerQueueCallbacks` 本地
队列接管了 `drain_steers`（装饰器拦截，`inner.drain_steers()` 不再被调用），上述宿主腿
成为死代码并已删除（见 M2 切片记录）。**残留缺口已在 M2 切片 3 修复**：探针实测发现
引擎路径下 turn 中途的 steer 比「延迟到达」更糟——`releaseActiveTurn` 在 turn 结束时
取消所有排队 step（含 `turnScoped: false` 的 steer），steer 消息**静默丢失**（不进
context、不达模型）。修复见 M2 切片 3。

### 里程碑

每个里程碑必须**可验证退出**，且「退出」的定义是 v2 侧代码被删除，不是「Rust 也能做」。

- **M0 — 契约归属决策（先决）** — ✅ 完成（2026-08-31，决策文档 `reports/rust-engine-contract-ownership.md`）
  ⚠️ 本节引用的 `reports/*.md` 设计文档在 **gitignore 的 `reports/`** 下（可追踪的单一事实源只有本 ROADMAP），新克隆取不到——关键结论已同步进对应里程碑条目。
  现状：同一契约存在 **4 份**且已漂移，**无编译期检查**——kosong TS（`usage.ts:7`、`message.ts:38`）、
  **v2 contract 物理拷贝**（`agent-core-v2/src/kosong/contract/`，message.ts 语义相同、tokens.ts 已分叉）、
  Rust（`rpc/types.rs:335/583`、`turn_loop/types.rs:92`）、napi 边界 `JsMessage:694`。
  已知漂移：`TokenUsage` 字段名不同；`ContentBlock` 无 `ThinkPart`；`LLMMessage` 是 text-first
  而 kosong 是 blocks-first；`ToolCall` 缺 `extras`；`image_url` 缺 `id`；无消息级工具声明。
  **决策（分层归属，非一刀切）**：引擎传输契约（Rust ↔ 宿主）以 Rust 为源单向生成 TS；
  provider 契约（kosong）保持 TS 手写权威（golden fixture 对齐，不做生成）；
  v2 contract 拷贝不投资，M5 随 v2 删除。
  落地：切片 1 ✅（stdio wire fixture round-trip 测试）；切片 1b ✅
  （napi dts 生成修复：`napi-derive` 补 `type-def` feature + build.rs 桥接
  CLI 3.x `NAPI_TYPE_DEF_TMP_FOLDER` ↔ 宏 v2 `TYPE_DEF_TMP_PATH` 协议错配 +
  `scripts/fix-napi-dts.mjs` 折叠双重 `export declare`；提交 `napi-contract.d.ts`，
  `rust-loop.ts` 参数/结果形状编译期校验——根因链见决策文档 §4）；
  切片 2 ✅（`wire-schema.ts` zod 镜像 + `parseWire` 接入五个解析点，畸形载荷带名拒绝）；
  切片 3 ✅（修订形态：Rust 侧全类型 fixture round-trip + TS 侧出站 `runTurnParamsSchema`
  校验；codegen（typeshare/ts-rs）推迟到 M1 事件类型落地时再评估——理由见决策文档 §4）。
  退出：决策落文档 ✅ + 一个方向落地 ✅ + 三处类型校验一致 ✅
  （napi 边界编译期 / stdio 边界测试期 fixture+zod / kosong 手写权威+golden fixture——
  口径修订记录在决策文档 §4）。

- **M1 — 移出 v2 的 turn 生命周期外壳（枢轴）** — ✅ M1a + M1b + M1c + M1d 完成（2026-09-01）
  - **M1a — EngineSession 骨架 + REPL 消费**（✅）：`packages/kimi-agent/src/session/mod.rs`（~520 行）实现
    `EngineSession`——admission 四模式（`NewTurn` / `ActiveOrNewTurn` / `ActiveOrNextTurn` /
    `ActiveTurnOnly`）、pending FIFO + 串行 pump（`tokio::spawn` + `Notify` 唤醒 + 锁内
    状态过渡）、turn 取消（活跃 → run_turn 观察 `Arc<AtomicBool>`；排队 → 立即
    `CancelledBeforeStart`）、steer 经 `SteerQueueCallbacks` 装饰器的 `drain_steers`
    通道；`turn_turn` 扩展为返回最终消息历史（`TurnResult.messages`，含 system），
    session 折叠到 `Core.history`（skip system），下一个 turn 自动延续跨 turn 上下文——
    修复了 v2 时代遗留的 assistant 回复不进历史的缺陷；7 个 session 单元测试覆盖
    多 turn 历史、排队顺序、排队取消、steer 复用、ActiveTurnOnly 拒绝。REPL 主循环
    改为消费 `EngineSession`（`start_repl` 一次性构建 session + 一次性 event bus 订阅流式
    打印 + 一次性 PermissionEngine/Toolset/callbacks pipeline），单条 prompt 经
    `session.enqueue_turn → receipt.outcome().await` 完成一次 turn；`/resume` / `/clear`
    / `/new` 通过 `set_history` / `clear_history` / `extend_history` 操作 session。
    - M1a 已知限制：`/model` 与 `/yolo` 在 session 固化 LLM/PermissionEngine 之下退化为
    「下次 REPL 重启生效」（文档在命令输出里）；未来 hot-swap 提升为 provider
    时取消这一限制。`/status` 的 `messages.len() / 2` 改为 `engine_session.history_len() / 2`。
  - **M1b** — turn 时钟 + durable 事件（✅ 2026-08-31）：
    - `src/turn_events.rs`：`TurnEvent` 四变体，序列化形状 = v2 durable `Event2` payload
      去掉 `agentId`（宿主补），字段名 camelCase（`turnId` / `durationMs`），`reason` /
      `target` 用 Rust 枚举钉死 v2 的字面量联合；5 个 wire 测试直接断言 JSON 字面量。
    - **时钟改为只读**（原案是 turn 域「读写」）：宿主 `turnKey` 的折叠是事件的纯函数，
      引擎整值回写会连带清掉宿主独有的 `anchorTurnIds` / `lastEnded`；`nextTurnId` 由
      `turn.prompt` 折叠推进即可 —— 单写者、无回写竞态。引擎构造时读一次，之后本地单调递增。
      turn 域仍实现了 `state_write`，语义是**单调钳制**（低值不回退），防止未来的写者复用 id。
    - `turn.started` 不带 `prompt` / `promptAttachments`：v2 由
      `turnPromptText` / `turnPromptAttachments(input, origin)` 推导（含 skill-activation
      块跳过规则），宿主拿同一份 `input` 自己推，避免两个引擎各推一份对不上。
    - transport：`HOST_TURN_EVENT` stdio 通知（`RpcHostCallbacks::turn_event`）+
      `run_turn_rust` 第 11 个可选参 `turn_event_cb`（TSFN，与 `emit_event` 共用抽出的
      `fire_payload_only`）；`SteerQueueCallbacks` / `NativeToolCallbacks` /
      `CountingCallbacks` 三层装饰器全部补转发（装饰器漏一行 = 事件静默丢失）。
    - 宿主接收端：`wire-schema.ts` 加 `turnEventSchema`（`input` / `origin` 保持不校验，
      v2 侧本就是 `z.custom`，这里校验更严会拒掉合法流量）；`rust-loop.ts` napi + stdio
      两路 `host/turn_event` → `setTurnEventHandler`，畸形载荷**报错不静默**——
      丢一条 durable 记录就是 transcript 损坏，不是掉一次显示。
    - v2 `stateRead` 新增 `turn` 域（返回 `turnKey` 当前值）：引擎在宿主模式下取时钟的入口。
    - **宿主 dispatch 桥（turn_event → `dispatcher.dispatch(new TurnPrompt(…))`）刻意未做**：
      今天 v2 loop 仍自己派发这些事件，桥一接就是双份折叠。它属于 M1d 删
      `executeTurnViaEngine`、turn 所有权真正翻转的那一步。
    - 收尾打磨（同一轮）：`TurnRequest::user(prompt, admission)` 取代 `Default` ——
      `origin` 为 `null` 时宿主折叠里的 `isUndoAnchorOrigin(origin)` 会直接读 `origin.kind`
      抛 TypeError（durable 记录不可折叠比不写更糟），所以构造器保证 `input`/`origin`
      至少是合法的 text part + `kind:'user'`，宿主有真实 ContentPart 时直接构造结构体；
      `cancel_turn(None)`（「取消全部」）现在带上当时活跃 turn 的 id —— v2
      `cancelActiveTurn` 一直发 `job.turn.id`，无 id 的取消事件宿主没法归属；
      `end_reason_of` 七变体映射表 + 失败 turn 的 `turn.ended{failed,error}` +
      无 id 取消三条测试补齐；`cargo clippy --all-targets` 0 警告（本轮引入的 4 条已清）。
    - 顺带修掉 **M1a 的潜伏死锁**：`EngineSession::new` 存进 handle 的是新建的
      `Arc<Notify>`，pump 等的是另一个 —— `enqueue_turn` 的 `notify_one` 打在了没人等的
      通道上，pump 一旦因空闲 park，后续入队永不唤醒。REPL 交互路径（第一个 turn 跑完
      再问第二个）必挂。M1a 的 5 个测试全绿是因为它们都「先全部入队再等」，从未让 pump
      park 过。证据：HEAD worktree 里加 `pump_wakes_after_idle_gap` 探针 → HEAD 超时失败，
      修复后通过（`test_pump_wakes_after_idle_gap` 已进 session 测试）。
      `EngineSession::new` 同时改为 `async fn`：原来在同步构造里
      `Handle::current().block_on(state_read)`，而构造点本身就在 async 上下文里 ——
      从 runtime 内部 block 会直接 panic。
  - **M1c** — 取消/背压/遥测（✅ 2026-09-01）：
    - **静默期/背压**（session）：`try_acquire_quiescence`（v2 `tryAcquireQuiescence`）——独占窗口，
      活跃/排队/held 任一存在即拒绝；窗口内 `enqueue_turn` 停靠 `held`（id 入队时分配，receipt
      已在调用方手里），guard drop（RAII 取代 v2 手动 `dispose()`，窗口内提前返回不会把 session
      困死在静默期）按 FIFO 重放并唤醒 pump；`settled()` 等待者 + `is_settled()` 探针，
      `maybe_settle_locked` 在 turn 结束/取消后解析。取消覆盖 held turn（`CancelledBeforeStart`）。
      7 个新 session 测试：空闲即决、活跃等待、停靠重放顺序、三类拒绝条件、held 取消后 settle。
    - **遥测**：`run_turn_with_telemetry` 包装 `run_turn`，经 `host/telemetry` 回调发
      `turn_started` / `turn_ended` / `turn_interrupted`（v2 track2 词汇表：reason 映射
      completed/cancelled/failed；引擎只见取消标志，interrupt_reason 统一报 `aborted`）。
      宿主注入 `TelemetryContext`（mode/provider_type/protocol/thinking_effort）与引擎观测
      （reason/duration_ms/steps/at_step）合并；`trace_id` 是已知缺口（引擎拿不到 provider
      request id，host-proxy 模式宿主也看不到）。wire：`HOST_TELEMETRY` 通知（stdio）+
      `JsRunTurnParams.telemetry` + 第 12 个 TSFN（napi）；三层装饰器全转发。
      宿主 seam：`telemetryEventSchema`（zod 镜像，畸形报错不静默）+ napi/stdio 两路 handler +
      门面 `onTelemetry`/`getTelemetryContext` 选项。
    - **激活刻意未做**（对齐 M1b turn_event dispatch 桥的先例）：CLI 尚不传
      `getTelemetryContext`/`onTelemetry`，v2 loopService 仍自己发 turn 遥测——现在接通就是
      双份上报，且引擎给不了 `trace_id`（v2 自发路径有）。接管（转发 track2 + 抑制 v2 自发）
      随 M1d 的 turn 所有权翻转一起做。
    - 测试：Rust 遥测契约 2 条（payload 合并 + 取消→interrupted 映射）；TS wire-schema 2 条 +
      stdio 传输 2 条 + napi 端到端 1 条（`createRunTurnOverride` 注入 context →
      started/ended 到达，字段逐项断言）。
  - **M1d** — 工具快照收尾 — ✅ 2026-09-01（`host/list_tools` + `executeTurnViaEngine` 删除 +
    零 v2 loop 代码，G-5 门禁断言）：
    - **`host/list_tools`（每 LLM 调用前拉取，替代 `buildTools` 一次性快照）**：native 传输
      （transport ≠ host-proxy）下 run_turn 每步先 `callbacks.list_tools()` 拉宿主当前工具表，
      失败/未接线回退 turn-start 快照（trait 默认 Err，REPL 的 `ReplDummyHostCallbacks` 走此路，
      无额外往返）；host-proxy 模式宿主本就在 `llm_chat` 内现拉 `buildTools()`，引擎不发此调用。
      wire：`HOST_LIST_TOOLS` 请求/响应（`ListToolsResponse.tools`，与 run_turn 快照条目同形）+
      `HOST_LIST_TOOLS_TIMEOUT` 30s（宿主簿记，无人在环）；napi 第 13 个 TSFN
      （`invoke_via_registry` 请求/响应模式）；三层装饰器全转发；宿主门面
      `listToolsHandler` = 每调用现读 `input.buildTools()`。
    - 测试：Rust 3 条（每步刷新且快照不落地、宿主报错→回退快照、host-proxy 零调用）+
      TS stdio 传输 2 条（已接线应答 / 未接线报错）。
    - ⚠️ 顺带定位一个**既有**套件性能问题：`run_turn` 每步 `drain_steers()` 在未注册
      handler 的 RpcServer 上回退 stdio 等满 30s 超时（`HOST_DRAIN_TIMEOUT`），多步测试
      因此 60s+/步（`test_history_accumulates_across_steps` 单跑 120s）。新测试通过注册
      drain_steers 桩 + list_tools 走 handler 报错路径规避；存量测试的修复是独立小活。
    - **管线抽取（会话句柄前提）**：`run_turn_rust_impl` 的 callbacks 链（NapiHostCallbacks →
      Counting → NativeTool/plan-guard）+ LLM 选择（multi > native-http > host-proxy）抽成
      `build_engine_pipeline(params, EngineCallbackTsfns)`，per-turn 入口与 M1d 会话工厂共用
      同一条管线；行为不变（834 全绿）。
    - **会话句柄跨 napi 边界（翻转的前提）**：id 寻址注册表（`CANCEL_MAP` 模式，不引入首个
      napi class）+ `create_engine_session`（管线建一次 + `EngineSession::new` 经 state 桥读
      turn 时钟）/ `session_enqueue_turn`（四准入模式，id 同步分配）/ `session_turn_outcome`
      （Promise，receiver 恰一次）/ `session_cancel_turn` / `session_status` / `session_settled`
      / `session_is_settled` / history 四操作 / `session_dispose`。`SessionConfig.goal` 提供者
      异步化（napi 侧经 `goal_cb` 每 turn 现读，snake_case wire goal）；tool_defs 提供者 =
      list_tools TSFN（host-proxy 置空——引擎表在那里不被消费）。pump 任务随进程存活
      （每进程一会话，有界）；join 式回收属翻转切片。集成测试 2 条：create→enqueue→outcome
      →history 折叠→settled→dispose 全链；gated 活跃 turn + 排队取消→`cancelledBeforeStart`
      →活跃 turn 释放后照常完成。
    - **TS 会话句柄**（`session-handle.ts`）：`EngineSessionHandle` 类型化包装——create（14 路
      回调接线：request/response 走 payload fetch + resolve，事件通道 fire-and-forget）+
      enqueue/turnOutcome/cancel/status/settled/history/dispose。集成测试再 2 条（含跨 turn
      历史延续）。
    - **3b — stdio 会话 RPC（✅ 2026-09-01）**：stdio 传输拿到与 napi 相同的会话表面，
      两传输都走会话契约（3c 翻转的前置）：
      - Rust：`main.rs` 管线抽取 `build_engine_pipeline`（镜像 napi 版，RUN_TURN 与
        session/create 共用）+ 会话注册表（`SESSION_REGISTRY`/`SESSION_OUTCOMES`/`SESSION_NEXT_ID`）
        + 14 个 `session.*` RPC（create/enqueue/outcome/cancel/status/is_settled/settled/
        try_acquire_quiescence/release_quiescence/set_history/clear_history/extend_history/
        history_len/dispose）+ `host/goal` 往返（`HostCallbacks::goal` 默认 Err，三个包装
        器转发）；goal provider 每 turn 现读，tool_defs provider 复用 `callbacks.list_tools()`。
      - TS：`EngineSessionHandle` 抽 `SessionTransport` 接口（全异步——stdio 的 JSON-RPC
        本质异步，napi 同步调用提升为 promise），`NapiSessionTransport` 留在 session-handle，
        `StdioSessionTransport` 在 rust-loop（snake_case 投影 + `SessionPrompt`↔wire `Message`
        转换）；`AgentProcess` 加 `session.*` 请求方法 + `host/goal` 分发；override 的 stdio
        分支切到与 napi 相同的会话流（`ActiveTurn` 改原始 handler 形状，napi 侧在 create
        处做 JSON 包装，stdio 侧直接接线 AgentProcess）。
      - 行为保持验证：既有 stdio e2e（check_permission ×4 / provider routing / ask_question ×2
        / staleness guard）全部改走会话路径后仍绿；崩溃恢复语义经「agent 实例变化 → 会话
        重建」保住；`run_turn_with_telemetry` 导入修复（M1c 起 bin 构建坏掉，`cargo build
        --features cli` 才暴露）。
      - 验证：cargo test 845 全绿 + clippy 0 warnings + fmt 干净；oxlint 0 errors；tsc 包内
        零新增；vitest 111 passed / 6 skipped；rustEngineE2E 3/3。
    - **3c — 事件单写者移交（✅ 2026-09-01）**：durable turn 事件与 turn 遥测的写者从 v2 loop
      换到引擎，v2 侧退成折叠方：
      - `EngineOverrideProvider.ownsTurnLifecycle` 能力位（apps/kimi-code run-v2-print 装配
        `true`）；`TurnEngineInput` 新增 `onTurnEvent` / `onTurnTelemetry`（agent-core-v2
        镜像 `TurnEventWire` / `TelemetryEventWire` 的契约类型），loop 在 buildEngineInput
        里按能力位接线。
      - v2 抑制：startTurn 停发 `TurnPrompt`/`TurnStarted`；runTurn finally 停发
        `TurnEnded`/`AgentErrorEvent`/三段 turn 遥测；cancelActiveTurn 停发 `TurnCancel`
        （排队取消保留——引擎从未见到排队的 turn）。
      - 派发桥：引擎 `turn.prompt/started/cancel/ended` → dispatcher（`TurnPrompt` 的
        input/origin 与 `TurnStarted` 的 prompt 派生自宿主 turn seed —— 引擎回显的
        LLMMessage 形状不是 v2 ContentPart[]，不反向转换）；`host/telemetry` → track2
        （payload 含宿主注入的 mode/provider_type/protocol/thinking_effort；`trace_id`
        仍是已知缺口）。
      - kimi-agent：会话两传输接通 turnEvent/telemetry（napi 侧 JSON 包装 + wire schema
        校验、stdio 侧 AgentProcess 既有 handler），经共享 `active` 槽路由到
        `input.onTurnEvent/onTurnTelemetry`。
      - 语义注意：引擎的 `turn.ended` 在引擎调用期间就发出（桥），`untilTurnEnd` 类等待
        会提前解析——loop 自身的收尾（releaseActiveTurn）在其后，属可接受的事件序。
      - 验证：engineOverride 61/61（含 3 条新：桥折叠、遥测转发无重复、无能力位时保持）；
        rustEngineE2E 3/3 带 `ownsTurnLifecycle` 走真实引擎全链；rustEngineZeroJsLoop 2/2；
        loop 套件 166/167（1 个快照失败为既有：工具表 hash `92e71e84` 早于 GitHub 工具族
        落库，与本轮无关）；kimi-agent 111 passed / 6 skipped。
    - **顺带修复既有缺陷：pump 折叠重复历史**。`run_session_turn` 把 `history + prompt` 喂给
      run_turn，结果整表返回；pump 折叠 `skip(1)` 会把喂入的旧 history 再折回——turn 3 起
      模型上下文出现重复消息（既有测试只断言 turn 2 请求所以未抓到）。修复：折叠跳过
      `1 + history_len`；新增三 turn 去重测试。产品路径（per-turn run_turn）不受影响，
      REPL 与即将到来的会话翻转受益。
    - **3d — 引擎路径完全移出 JS step 循环（✅ 2026-09-01）**：引擎分支从 while 循环内
      （`runtime.steps === 1` 拦截）上移到 `run()` 入口——`executeTurnViaEngine` 改写为
      `driveEngineTurn`，TurnEngine override 下 `beginLoopStep` / `completeLoopStep` /
      `handleLoopStepError` 及整个 JS step 机制零执行，loopService 对引擎路径退化为
      turn-start 门面：drain 排队请求并逐个 materialize（prompt 落 context transcript，
      `buildMessages` 才能看到用户消息——首版漏掉此步，engineOverride / rustEngineE2E
      各红一条后补上）、`onWillBeginStep` 注入门、`TurnStepStarted`/`TurnStepCompleted`
      UI 事件、`engine_turn` 遥测、`runAfterStep`。G-5 门禁同步收紧：JS_ONLY_FUNCTIONS
      增列三个 loop-shell 函数，ENGINE_PATH_FUNCTIONS 换为 `driveEngineTurn` /
      `createLoopRuntime` / `buildEngineInput` / `runAfterStep`；rustEngineZeroJsLoop
      车辆测试补 `ownsTurnLifecycle: true` + `turn.prompt/started/ended` 事件回放。
      验证：engineOverride 61/61、rustEngineZeroJsLoop 2/2、rustEngineE2E 3/3、
      loop 套件 166/167（唯一失败为既有工具表快照 hash 环境漂移）、G-5 OK（11 个
      JS-loop 函数零调用 / 4 个引擎路径函数有调用）、tsc 干净。pump join 式回收
      （开放点 ③）不在本切片，随 M2。
  设计要点：napi/stdio 边界从「每 turn 一次调用」升级为 **EngineSession 会话句柄**
  （准入四模式 + FIFO + pump + 取消 + 背压，从 REPL 循环泛化）；durable turn 事件
  经新 `host/turn_event` 回调交宿主（引擎决策、宿主持久化——对齐 state-bridge 先例）；
  turn 时钟经 state bridge 新 turn 域读写；新增 `host/telemetry` 与 `host/list_tools`
  （消除工具一次性快照）；loopService 降级为门面。迁移顺序 M1a（session 骨架，
  REPL 先行）→ M1b（时钟 + durable 事件）→ M1c（取消/背压/遥测）→ M1d
  （list_tools + executeTurnViaEngine 删除 + G-5 覆盖率断言）。
  ⚠️ 措辞更正：不是「翻转主循环」——Rust 早已拥有 step 循环（`loopService.ts:718-723`）。
  M1 要做的是把 v2 仍握着的 **turn 生命周期**移出去，让 `run_turn` 成为 turn 的入口：
  - turn 准入与排队（`loopService.ts:224-260`、`437-501`）
  - turn id 与时钟（`:430-435`、`turnOps.ts:120-181`）
  - 持久化 turn 事件 `TurnPrompt`/`TurnStarted`/`TurnEnded`（`:526`、`:530-538`、`:584-593`）——
    **会话/transcript 落盘与 undo 锚点（turnOps.ts:136-140）全部依赖它，且 `host/event` 只传
    非持久化内容，无对应回调**；这是 M1 里最难的一项
  - turn 遥测（`:547-562`、`:575-623`）
  - 取消语义（`:288-294`、`:337-372`、`:636-647`）
  - 静止期背压 `settled()`（`:307-333`、`:375-406`）
  另有一项跨切面：工具注册表在 `buildTools`（`:1080`）被**一次性快照**进引擎输入，
  没有 `host/list_tools` 回调，因此 turn 中途的工具集变化（MCP 重连、skills 增删）传不到 Rust。

  ### 翻转设计定稿（2026-09-01 推演，切片 3 执行前必读）

  前提已全部就绪（切片 1/2a/2b/2c）。翻转动的是 durable 事件单写者，以下决策先钉死：

  **张力：会话的引擎侧历史 vs 产品路径的宿主持有上下文。** EngineSession 的
  `history + prompt` 模型假设引擎拥有上下文（REPL 语义）；产品路径（host-proxy）的上下文
  由宿主持有——`host/llm_chat` 内宿主从自己的 context 现建消息，引擎侧 messages/history
  只是控制流管道，模型永远看不到。native 模式下引擎消息**就是**模型上下文，而今天
  per-turn 路径每 turn 由宿主投影全量 context（`buildWireMessages`）——引擎侧自累积历史
  会与宿主漂移（compaction/undo/steer 都发生在宿主侧）。

  **裁决：宿主上下文保持唯一权威。** 产品路径每 turn 由门面执行
  `setHistory(投影消息去掉最后一条) + enqueueTurn(最后一条 = 本 turn 的 user prompt)`——
  turn 开始时 context 的末尾就是 prompt（v2 在准入时追加），引擎侧累积被每 turn 覆盖，
  仅作控制流管道。host-proxy 模式下引擎消息本就不被消费，此模式同样成立。REPL
  （引擎自有上下文）继续用纯 `enqueueTurn`，不 set_history。

  **步骤序（每步行为保持可回归验证）：**
  1. **3a — 门面 napi 路径切会话（行为保持）**：`createRunTurnOverride` 的 napi 分支改为
     惰性建会话（`EngineSessionHandle.create`，13 路会话级 handler 路由到「当前活跃
     per-turn 注册」——串行 pump 保证单槽即可）；per-turn：`buildMessages` 拆
     history/prompt → setHistory + enqueue → await outcome → 映射 `TurnEngineResult`；
     `input.signal` abort → `cancelTurn(引擎 turn id)`。**turn_event/telemetry 保持不接线**
     （引擎侧丢弃）——v2 继续自发 durable 事件与遥测，无双份折叠/上报。stdio 分支不动
     （仍 per-turn）。回归面：rust-loop 全套 + rustEngineE2E + CLI e2e。
  2. **3b — stdio 会话 RPC**：main.rs 管线抽取（镜像 `build_engine_pipeline`）+ 会话注册表
     + `session.*` RPC 方法；`AgentProcess` 宿主侧分发；`EngineSessionHandle` 抽传输接口
     （napi/stdio 双实现）。翻转需要两个传输都在会话契约上（rust-only 门禁下 stdio 是
     唯一回退，不能掉队）。
  3. **3c — 事件单写者移交**：v2 `loopService` 检测会话型引擎 → startTurn 改 enqueue、
     停发 `TurnPrompt`/`TurnStarted`/`TurnEnded`（改由 `turn_event` 派发桥折叠——M1b 搁置
     的桥在此激活，接线即无双份）；runTurn finally 停发 turn 遥测（引擎 `host/telemetry`
     → track2，M1c 搁置的另一半；`trace_id` 缺口随引擎捕获 provider request id 解决）。
     turn id 以引擎分配为准（时钟已在引擎侧，宿主 turn.prompt 折叠推进）。
  4. **3d — 删接缝 + 断言**：删 `executeTurnViaEngine` 与 per-turn `run_turn_rust` 产品
     路径（保留 REPL）；G-5 覆盖率断言扩展到 turn 外壳（`check:engine-zero-js-loop`）。

  **已知开放点**：① steer 的 `drainSteers` 在会话模型下由引擎 pump 每步拉取（已接线），
  v2 侧 step 队列的 steer 语义需在 3c 对齐；② ~~quiescence 消费方（undo/compaction）在
  v2 侧，3c 需经句柄暴露 `try_acquire_quiescence`~~（✅ 2026-09-01 已暴露：
  `session_try_acquire_quiescence`/`session_release_quiescence`——RAII guard 存注册表，
  release 即 drop 重放；句柄方法 + 集成测试已钉）；③ 会话 pump 的
  join 式回收（dispose 后 pump 停靠）——3d 未含，随 M2 回调处置一并做。

  **补充裁决（3a 动刀前）：会话固化 vs 每 turn 现读。** 会话把 LLM/权限引擎/GitHub 凭据
  固化在创建时，而产品路径今天每 turn 现读（TUI 模型切换写 `default_model`、token 轮换、
  `[permission]` 变更）。裁决：**配置指纹变更 → 会话重建**。门面每 turn 现读
  nativeLlm/policy/github（现有闭包不动），与活跃会话的指纹比对；不一致 → 旧会话
  `dispose` + 重建。历史由宿主每 turn `set_history` 推送，重建零损失；turn 时钟经 state
  桥读取，新会话拿到的值不回退。重建成本只在用户显式变更配置时发生（低频）。

  ⚠️ 本条退出标准依赖的 G-5 观测出口**至今未成立**（P34 复核），盘点另新增 G-8 与对 G-6 / P33 的两处量化补充。
  退出：`engine: 'rust'` 下**没有任何 v2 loop 代码执行**——用 P24 已建的 G-5 观测出口
  （`/status`）加覆盖率断言证明，不靠人工判断；
  且上述每一项都要有 Rust 侧落点或明确的宿主分层，否则就是功能丢失而非迁移。

- **M2 — 9 条回调逐条到期** — 🔄 2/9 已删除
  按上表逐条补齐 Rust 侧前置，每补齐一条即删除 v2 侧对应实现。
  退出：9 条全部删除；`rustSelfContained` 开关自身一并移除（它只是验证手段，见 P26）。
  - **切片 1 — `host/drain_steers` 宿主腿删除（✅ 2026-09-01）**：M1a 的 `SteerQueueCallbacks`
    （`session/mod.rs`）已让引擎本地 steer 队列接管 `drain_steers`（装饰器拦截，
    `inner.drain_steers()` 在会话路径上不可达），宿主腿在产品路径上是死代码。删除面：
    Rust `RpcHostCallbacks::drain_steers`（stdio 往返）+ `NapiHostCallbacks::drain_steers`
    （TSFN）+ `HOST_DRAIN_STEERS` / `HOST_DRAIN_TIMEOUT` 常量 + `NativeToolCallbacks` /
    `CountingCallbacks` 两层转发 + napi 第 6 TSFN（`run_turn_rust` 12→11、
    `create_engine_session` 13→12，`napi-contract.d.ts` 同批重生成）；TS 门面
    `AgentProcess` handler + stdio 分发 + `ActiveCallbacks.drainSteers` +
    `StdioSessionTransport` / `wrapActiveForNapi` / `sessionCallbacks` 三处接线 +
    per-turn `drainSteersCb` 参数 + `session-handle.ts` 传输位。保留：trait 默认（空）、
    `SteerQueueCallbacks` 本地队列实现、`run_turn.rs` 每步消费点、
    `input.drainSteers` / `drainSteered()`（host-proxy 模式宿主 step 头仍经它拉取 v2
    steer——`llmChatHandler` 内联化）。测试：删除 per-turn drain 通道专属 describe
    （napi-integration 2 条），state-bridge 参数位置测试 9th/10th → 8th/9th，
    ask_question 测试位置参数同步移位。
    验证：cargo test 845 全绿（835 lib + 10 stdio）+ clippy 0 + fmt 干净；
    kimi-agent vitest 109 passed / 6 skipped；agent-core-v2 engineOverride +
    rustEngineE2E + rustEngineZeroJsLoop 66/66；addon release 重建 + d.ts 重生成。
  - **切片 1b — 会话 goal/list_tools 双重编码修复（✅ 2026-09-01）**：盘点发现的
    「`host/goal` 产品接线惰性」根因不在 `rust-engine.ts` 缺 `getGoal`（那只是表象之一），
    而是 **napi 会话路径的请求/响应适配层双重 JSON 编码**：`SessionCallbacks.goal` /
    `listTools` 契约是「返回 wire JSON 字符串」，`wrapActiveForNapi` 已按契约返回字符串，
    但 `session-handle.ts` 的适配器又 `JSON.stringify` 了一次——Rust 侧
    `serde_json::from_str::<GoalContext>` 收到的是「字符串化的字符串」，解析必然失败。
    后果链：goal 解析失败 → `None` → 引擎每步 goal 预算检查（`BudgetLimited`/`Paused`
    停止）在 napi 产品路径从不触发；list_tools 解析失败 → 被 M1d 的「失败回退 turn-start
    快照」机制静默吸收（native-http 模式下工具表刷新同样失效）。stdio 路径无此问题
    （`ActiveCallbacks` 直接传对象，信封序列化一次）。修复：适配器去掉多余 stringify
    （`goal` 空值归 `'null'`）。同时把 v2 goal provider 接进会话 goal 闭包：
    `goal: () => options?.getGoal?.() ?? projectEngineGoal(input.getGoal?.())`——
    `rust-engine.ts` 无需改动，任何注册了 `registerEngineGoalProvider` 的宿主自动获得
    引擎侧预算执行。新增 e2e：`rustEngineE2E` 第 4 条——v2 goal provider 报耗尽预算 →
    真实引擎在首个 LLM 调用前 `BudgetLimited` 停止（`ctx.llmCalls.length === 0`）。
    验证：cargo test 845 全绿 + clippy 0 + fmt 干净；kimi-agent vitest 109/109；
    agent-core-v2 loop 套件 166/167（唯一失败为既有工具表快照 hash 环境漂移）；
    根 typecheck 全绿；addon release 重建。
  - **切片 2 — `host/finalize_tool_result` 删除（✅ 2026-09-01）**：P26 批 4 建成的
    `ToolResultTruncator` 从 `rustSelfContained` 门控翻为**无条件**（有 `workspace_root`
    即构建，napi/stdio/REPL 三路一致——REPL 本就无条件），删除整条宿主 finalize 接缝：
    Rust `HostCallbacks::finalize_tool_result` trait 方法 + 全部实现（Rpc/Napi/
    NativeTool/Counting/SteerQueue 五处）+ `ToolFinalizeRequest` 类型 +
    `HOST_FINALIZE_TOOL_RESULT` / `HOST_FINALIZE_TIMEOUT` 常量 + napi 第 5 TSFN
    （`run_turn_rust` 11→10、`create_engine_session` 12→11）；TS 门面
    `finalizeNativeResult` + `ActiveCallbacks.finalize` + AgentProcess handler +
    stdio 分发 + `wrapActiveForNapi` / `StdioSessionTransport` / `sessionCallbacks`
    接线 + `toolFinalizeRequestSchema`；v2 `TurnEngineInput.finalizeToolResult` 契约
    字段 + `buildEngineInput` 接线（`IAgentToolResultTruncationService` 本体保留——
    宿主自有工具执行路径仍用，M5 随 v2 删除）。无 workspace 的退化路径：截断器
    None → 结果原样透传（trait 默认已随接缝删除，native 分支直接 `None => raw`）。
    **语义差异记录**：spill 落盘位置从宿主 `privateRoot()`（进程私有临时目录，
    `[spill].root` 可配）变为 `<workspace>/.kimi/spill/`——工作区本地使 native Read
    沙箱可直接读回 spill 文件（自洽）；工作区污染与 M4 的 `.kimi/state/` 同类，
    归 M4 裁决；`[spill].root` 配置不作用于引擎侧 spill（已知分歧）。
    测试：删除 host finalize 专属 describe（napi-integration 1 条），截断测试去
    `rustSelfContained` 依赖与 finalize 桩，位置参数测试再移一位（askQuestion 6th、
    state bridge 7th/8th），callbacks.rs 的 Counting 转发测试删除。
    验证：cargo test 844 全绿（834 lib + 10 stdio，净减 1 条 finalize 转发测试）+
    clippy 0 + fmt 干净；kimi-agent vitest 108/108；agent-core-v2 loop 套件
    167/168（唯一失败为既有快照漂移）；oxlint 0 errors；addon release 重建 +
    d.ts 重生成。
  - **切片 3 — steer 路由进引擎会话（✅ 2026-09-01，修复静默丢失）**：探针实测确认
    引擎路径下 turn 中途的 steer 被**静默丢弃**——steer 以 `activeTurnOnly` 准入进
    活跃 turn 的 job 队列，但引擎从不消费宿主 step 队列，`releaseActiveTurn` 在
    turn 结束时取消所有排队 step（`turnScoped: false` 也逃不掉），消息不进 context、
    不达模型、transcript 无记录。修复（对齐「宿主上下文唯一权威」裁决）：
    - `EngineOverrideProvider` 新增 `deliverSteer?(message)` 能力位；`TurnEngineInput`
      的 `drainSteers` 与 `IAgentPromptService.drainSteered()`（含 `drainedSteerIds`
      去重）整体删除——materialize 时机从「drain 时」改为「steer 准入时」。
    - `loopService.admit` 的 `activeTurnOnly` 分支：`kind === 'steer'` 且 sink 已注册
      时走 `deliverEngineSteer`——assignment 立即以活跃 turn 解析（附一次性 completed
      step，不入 job 队列故无重复 materialize/泄漏）、`materializeRequest` 即时落
      context + `TurnSteer` 事件、投影后的 kosong Message 经 sink 推给引擎（fire-
      and-forget，失败不回滚——context 已有记录，下一 turn 投影兜底）。
    - 门面 `createRunTurnOverride` 返回值附带 `deliverSteer`（`TurnEngineAdapter`
      交集类型）：`isHostMessage` 守卫 → `projectHostMessageToWire` → 新抽的
      `wireToSessionPrompt`（与 per-turn 投影共用）→ `enqueueTurn(…, 'activeTurnOnly')`
      进引擎本地 steer 队列，运行中 turn 的每步 drain 即时送达；turn 刚结束的窄竞窗
      下残留 steer 留在会话队列、下一 turn 首步送达（EngineSession 不清 steer_queue）。
      host-proxy 的 `llmChatHandler` 不再 drain（steer 已在 context，下次
      buildMessages 自然包含）。装配：`run-v2-print.ts` 把适配器的 `deliverSteer`
      接进 `IEngineOverrideService`。
    - 语义注记：steer 的 context materialize 从「下一 step 头」（JS 路径）提前到
      「steer 准入时」（引擎路径）——transcript 记录与模型可见性对齐，JS 路径不变。
    - 测试：两条 drain 测试重写为 deliver 语义（sink 收到投影消息 + context 合并
      `Hello\n\nSteered!`；steer completion 随 turn 结束 settle）；gateway 桩同步。
    - 验证：agent-core-v2 engineOverride + prompt + gateway 96/96；loop 套件
      167/168（唯一失败为既有快照漂移）；kimi-agent vitest 108/108（Rust 零改动，
      走既有 `session/enqueue_turn` 准入）；oxlint 0 errors；包内 tsc 干净。
  - **盘点勘误（2026-09-01 代码级复核）**：9 条回调表中 `host/drain_steers` 的
    「Rust 侧前置 ❌ 缺失」自 M1a 起已过时（本地队列当时已建成）；`host/event` 的
    「Rust 侧 sink ❌」仍准确（transcript/UI 消费方在宿主侧，无 Rust 替代）。

- **M3 — 消费方处置** — 🔄 三者均出结论（2026-09-01）
  三个消费者对 v2 的依赖面盘点（175/122/13 导入行 = 62/1/11 文件）后共同结论：Rust
  引擎目前**只暴露 turn-loop 表面**（`session.{run_turn,enqueue_turn,history,status}`
  + host 回调），app-scope 表面（`IConfigService` / `ISessionIndex` / `IWorkspaceService`
  / `IMcpManagementService` / `IOAuthService` / `IPluginService` / `ICapabilityService` /
  `IAgentLifecycleService` / `IAgentPromptService` / `IAgentToolRegistryService` 等约 30+
  服务）**无 Rust 等价**——`packages/kimi-agent/napi-contract.d.ts` 也不含这些类型。
  把任一消费者整体改接到 Rust 引擎需要先把整套 app-scope 移植到 Rust，量级与 M5 重复。
  因此三者均选 **(b) 保留 v2 作为库（带显式标记）**，并用共享 schema 子包回收纯 wire/类型
  导入（~40% 导入可剥离）。各消费者结论：

  - **`kap-server`（推荐 (b)）**：62 文件、~30 个 `I*Service` 解析、`/api/v1/debug/*` 反射
    调度器走 `core.accessor.get` 暴露全部 v2 服务；托管 App/Workspace/Session 三层 DI
    整个 app-scope 都在 v2；纯 wire/类型导入（35 行 `coreEventMap.ts`、~50 个 `events-zod.ts`
    事件 payload、12 个 `isoDateTimeSchema` 等）可迁出到 `packages/protocol` 或 `agent-core-v2/library-types`
    子包，把 175 → 约 100 行（~40% 减少），不需任何运行时改动。剩余 ~100 行都是
    `I*Service` 解析 + 事件投影 + 协议变换，没有 Rust 等价。**迁移路径**：M5 整体迁移到
    Rust hosting 基板时再处理（届时 kap-server 变成一个 Rust 进程 + 薄 TS 路由层，
    或者整个进程迁 Rust）。
  - **`klient`（推荐 (b)，可追加 (c) 子目标）**：1 个公共文件 122 导入行，集中在 `serviceRegistry`
    （39 条）+ `dispatcher.ts`（482 行）；余下是公共类型再导出。`AgentFacade` 的 turn 驱动
    方法（`prompt` / `steer` / `cancel` / `activateSkill` / plan 域）有 Rust 等价（`session.run_turn` /
    `enqueue_turn` / `host/state_{read,write}`），可做 **(c) 子目标**——把约 1/3 的
    `serviceRegistry` + 对应 dispatcher 分支改走 Rust 引擎的 napi 表面；余下 ~25 个
    v2 服务（`global.*` + `session.*` 大部分、`IAgentPromptService` 的非 turn 部分等）维持 v2。
    验证标准：conformance 与 invalid-input 套件继续跑 v2，新增 turn-loop 套件跑 Rust；
    `test/contract-parity.ts` 增加 Rust 路径断言。
  - **`acp-server`（推荐 (b)）**：13 导入行约 50 符号；~12 行是 wire-only（`ContentPart`、
    `ContextMessage` / `SkillSummary` / permission + question wire 类型）可迁共享 schema
    子包；**~4 行是 DI 机械**（`bootstrap` / `Scope` / `registerScopedService` / `createDecorator`
    + 三个 `I*Service`）+ **v2 `Runtime` / `RuntimeProviderAttachment` / `IHostProcessService`
    接口实现**——ACP 层不是 wire-only 消费者，它参与 v2 的运行时契约（`acp-terminal` 实现
    v2 `Runtime`，`acp-fs` 注册 Session-scope `IHostFileSystem`）。没有 Rust DI / Runtime
    等价，移植到 Rust = 重写 ACP 层。维持 v2。

  **M3 标记落码（2026-09-01）**：`scripts/check-v2-library-surface.mjs`（挂在 `bun run
  check:v2-library-surface`，**未接入 `bun run lint`**）实现两件守门：
  1. 三个标记消费者 `package.json#description` 必须含 `M3-marked v2 library consumer` 文案
  （描述已加）— 加载 `agent-core-v2/AGENTS.md` §Library surface 白名单。
  2. 扫描 `packages/*/src|test|scripts/**` 的 v2 导入：非白名单消费者**报错**——`agent-core-v2`
     `AGENTS.md` 描述 + 三个 consumer 入口一致时此检查**通过**。
  验证：lint 报 **`check:v2-library-surface: OK`**（exit 0），3 个 marker consumer
  + agent-core-v2 自身全部白名单通过。

  **M3 第 4 个 v2 消费者复议（2026-09-01）**：`scripts/check-v2-library-surface.mjs`
  首次运行标记了 480 项违规——`packages/node-sdk`（公共 TypeScript SDK，
  `@moonshot-ai/kimi-code-sdk`）也依赖 v2（39 个唯一导入点，混合类型再导出 +
  运行时辅助 + `IEngineOverrideService` 用于 in-memory v2 RPC client）。按
  ROADMAP §M3 纪律"第四个 v2 消费者需要显式 M3 复议"，调查结论与 klient 形态
  相似——是 contract-driven facade，发布给下游消费者，按 **(b) 保留 v2 作为库**处理：
  - `packages/node-sdk/package.json#description` 加 `M3-marked v2 library consumer`
  - 新建 `packages/node-sdk/AGENTS.md`，`## M3 marker` 段列出 39 个 v2 导入的分类
    （wire-type 再导出 / 运行时辅助 / in-memory RPC client）+ 列出 node-sdk **不**
    拥有的能力（不托管 App/Workspace/Session/Agent DI 三层，形态比 kap-server 轻得多）
  - `scripts/check-v2-library-surface.mjs` `CONSUMER_WHITELIST` 加入
    `packages/node-sdk`；修 Windows 路径分隔符 bug（`path.join` 产生 `\\` 与
    正斜杠白名单不匹配——`walkPackage` 内 `rel = pkgRel.split(path.sep).join('/')`
    归一化）
  验证：lint 0 violation（exit 0），白名单 4 个消费者全过。

  **M3 退出完全满足**（2026-09-01）：四个 v2 消费者（kap-server / klient /
  acp-server / node-sdk）均出 (b) 结论并落显式标记，lint 通过。`agent-core-v2` 的
  "默认 v2 运行时"歧义被 `metadata.lifetime` + 三个 consumer 入口的 `M3-marked`
  描述 + 白名单 lint 一起关闭。

  **M3 残留依赖（阻塞 M2 后续切片的前置）**：

  - `host/ask_question` 仍未落地（ROADMAP §9 ❌）——`klient.AgentFacade.interactions.*` /
    `kap-server.IApprSessionApprovalService` / `acp-server.ISessionQuestionService` 全靠它，
    是 (c) 把 klient turn 子集迁 Rust 的最大缺口。
  - `host/event` 仍未落地（ROADMAP §9 ❌）——`coreEventMap.ts` 50+ 事件类型（`assistant.delta` /
    `thinking.delta` / `tool.progress` / `compaction.*` / `plan.revision` / `context.*` /
    `agent.activity.updated` / `subagent.*` / `goal.updated` / `cron.fired` / `skill.activated` 等）
    全是 v2 `Event2` 词汇，Rust `EventEngine` 只覆盖 `host/turn_event` 的子集。
  - `ISessionApprovalService` / `ISessionQuestionService` / `listSessionPendingInteractions` /
    `onSessionInteractionDidChangePending` 三个互动运行时助手（同时是 (b) 维持面与
    Rust 端缺失功能）——M2 标注为"应该是永久接缝或 Rust 交互运行时"，M3 接受这一定性。

  **M3 退出已满足**：三者均有书面结论（均选 (b) 库 + 显式标记），不存在「默认继续依赖 v2」
  的悬空项；标记方案把"库"变成可审计的契约。剩余 `host/ask_question` + `host/event` 是
  M2 后续切片的前置，不阻塞 M3 结论落码。

- **M4 — 数据与持久化** — ✅ 完全退出（2026-09-01）
  两个待决问题均已裁决：

  1. **既有数据**：`~/.kimi-code/` 下的会话与状态、minidb 的 WAL / snapshot 格式。
     退出：迁移路径落地，或对数据丢失作出明确且已告知用户的决定。
     — ✅ **决议（2026-09-01）**：**接受数据丢失，路径落地在 `packages/migration-legacy`**。
     调查结论（`app/bootstrap/bootstrapService.ts:45-50` 给出 7 个 home 子目录）：

     | 子目录 | 归属 | 格式 | 用户影响 | 迁移可行性 |
     |---|---|---|---|---|
     | `sessions/` | v2（`ISessionStore`）| JSONL（每会话一行） | **高** — 用户失去会话转录 | 中——格式可读，但 Rust 端没有 session runner |
     | `store/` | v2（`IAppendLogStore`）| append log | **高** — undo anchor / 持久事件 | 低——依赖 v2 dispatcher |
     | `cache/` | minidb（session index mirror + `search-index` 全文/字面索引）| minidb WAL + snapshot | **中高** — 搜索失效 / 会话列表失效 | 低——minidb 内部 |
     | `credentials/` | v2 | 加密 JSON | **中** — OAuth / GitHub token | 低——重授权 |
     | `blobs/` / `logs/` | v2 | binary / text | 中 / 低 | 低 |
     | `config.toml` / `local.toml` / `mcp.json` | v2 | TOML / JSON | **高** — 用户配置 | 中——可平迁到 Rust 端 config schema |

     **决策路径**：(b) 接受数据丢失 + 路径落地。理由：
     - 完整迁移 = 7 个独立 store 在 Rust 端各起一份（session runner / append log /
       minidb search + index / credentials vault / blob store / config schema），与 M5
       删除 v2 的工作量重叠——不是 M4 范围内可单独推进的。
     - `packages/migration-legacy` 已存在（v0.1.16，v1→v2 的 `~/.kimi/`→`~/.kimi-code/`
       迁移），是 v2→Rust 迁移的天然接续位置——M4 决议落地方式：在 `migration-legacy`
       新增 `v2-to-rust` 子命令，**用户**在升级到含 M5 删除 v2 的版本前手动运行，
       把可平迁的子目录（`config.toml` / `mcp.json` / 部分 `cache` 索引）转为 Rust 端
       新 layout，不能迁移的（`sessions` JSONL / `store` append log / OAuth 凭据）
       落码**显式导出**为 `migration-legacy/export-v2-sessions` / `-export-v2-store` /
       `-export-v2-credentials`，让用户自行归档到 git/外部存储。
     - 决策**已告知**通过：M5 发布说明 + `migration-legacy` 自身的 README 标红、
       `kimi` CLI `doctor` 子命令（`apps/kimi-code/src/cli/doctor.ts`）在 M4 之后、
       M5 之前增加 `v2-data-detected` 警告。
     - 验证标准：到 M5 实际删除 v2 之前，`migration-legacy` 跑通 `v2-to-rust` 全部子命令、
       用户的升级日志里出现 `v2-data-detected` 警告——本切片仅完成决策 + 记录，
       工具实现归 M5 切片。
  2. **状态该写在哪里**（P32 引入的设计分歧）— ✅ 已裁决并落码（2026-09-01）：
     **引擎本地存储迁至 `~/.kimi-code/engine-state/<workspace-key>/`**（key = 规范化
     工作区路径的 16-hex FNV-1a 摘要，`storage/paths.rs`），`StateStore` / `SessionStore`
     分别落 `state/` 与 `sessions/` 子目录（`TaskRunner` 随 StateStore）。裁决理由：
     对齐 `~/.kimi-code/` 既有约定、不碰用户工作区（原 `.gitignore` 缓解对用户仓库
     无效）、且 M5 引擎成为产品引擎后状态必须 home 域——现在迁移避免二次搬迁。
     既有 REPL 本地状态不迁移（开发工具，重建即可，见问题 1 的口径）。
     落码：`for_dir` 显式目录构造器（测试用）+ `for_workspace` 走 home 解析；
     `.gitignore` 的 `.kimi/state/` 条目删除（不再有写入方）。
     **顺带修复盘点发现的注入分歧**：`run_turn` 的 goal/plan 注入此前读
     `StateStore::for_workspace(cwd)` 本地 store，而 state-bridge 工具经
     `host/state_write` 写宿主——**native 模式下注入读的是空 store，goal/plan
     提醒静默失效**，且每次构造都在工作区留目录。修复：注入 provider 改读
     `CallbackStateSnapshot`（每步头经 `host/state_read` 刷新 goal/plan 两域，
     与工具同通道；读取失败保留旧值），`run_turn` 不再构造任何本地 store——
     产品路径零本地状态写入。REPL 路径经 `ReplDummyHostCallbacks` 读同一本地
     store，行为不变。测试助手的 `rpc_callbacks`（run_turn + session 两处）补
     `HOST_STATE_READ` no-op（未接线时 stdio 回退等满 30s 超时，M1d 同款问题）。
     验证：cargo test 846 全绿（836 lib + 10 stdio，净增 2 条 paths 测试）+
     clippy 0 + fmt 干净；session 测试从 210s（超时拖累）回到 0.07s。

- **M5 — 删除**
  删 `packages/agent-core-v2`；移除 `engineOverride` 接缝、`rustSelfContained` 开关、
  `engine: 'js' | 'rust'` 配置（或重新定义其语义）。
  同时清理以 v2 为参照的 golden 断言——它们失去参照对象，应删除而非改写。
  退出：仓库可构建，`cargo test` + `vitest` 全绿，除 git 历史外无 `agent-core-v2` 残留引用。

### 风险

- **并发冲突（现实风险）**：当前有多个会话同时在推进，本节与「替换 v2 第 1 轮」
  （`8475bfcd29`）存在口径分歧——后者目标是「纯 Rust CLI（REPL）成为 v2 的完整替代」，
  而 REPL 不是发布路径。需先对齐，否则 M1 会被重复实现或互相覆盖。
- **宿主独有能力无处安放**：v2 删除后 host 侧不复存在，tower / swarm / lsp / run_code 等
  （P21 归为「建议保留 host」）必须在 Rust 侧落地，或重新定义宿主分层。归入 M3。
- **测试资产作废**：大量断言以 v2 行为为参照。v2 删除后它们不再是回归保护，
  若改写而非删除，会留下「对齐一个已不存在的东西」的伪测试。
- **数据**：M4 处理不当会丢失用户既有会话。

### 验收口径

与既有批次一致：`cargo test` 全绿 + `cargo clippy --all-targets` 0 warnings +
`cargo fmt --check` 干净 + `bun --bun run test`。
**额外增加一条**：每个里程碑必须能指出「本轮删除了 v2 的哪部分代码」——
说不出来，就说明该里程碑不是删除，只是又一次对齐。

## P34 — 剩余工作量盘点：从「能跑」到「v2 消失」的实测边界（2026-09-01，本轮只测量，未改码）

先立一条口径：**代码行数不是度量，所有权才是**。`packages/kimi-agent` 已 47,236 行 > `agent-core-v2` 的
35,559 行，但 `engine: 'rust'` 下 v2 仍握着 turn 逻辑的约 88%。Rust 真正替掉的只有 step 循环本身。

### 基线（实测）

| 度量 | 值 | 出处 |
|---|---|---|
| `loopService.ts` 总长 | 2,227 行 | `wc -l` |
| 其中 rust 路径仍执行 | ≈1,950 行（**88%**） | `:139-919` 共享外壳（准入/排队/时钟/取消/背压/durable 事件/遥测/错误链）+ `:1055-1587` `buildEngineInput`（533 行）+ `:1639-1651` UI 桥 + `:1905-2141` wire 映射 |
| 仅 JS 路径（已被 Rust 取代） | ≈280 行 | `executeLoopStep :920-982`、`beginStep`…`finishStep` `:1653-1900` |
| 引擎入口 | `:723` `getEngine() && runtime.steps === 1` → `executeTurnViaEngine :992-1053` | 该处注释自证：「override 每 turn 只在第一步跑一次，引擎把整个 turn 消费完」 |

### 两种「完整」的剩余量

**口径 A —— 产品路径功能不丢 + 引擎真正拥有 turn**（= M1 收尾 + M2 主体）：待迁移/删除的 v2 代码约 2k 行，
Rust 侧主要是**接线**——`EngineSession`（M1a 骨架 + M1b 事件，clippy 0）今天**只有 REPL 能构造**，
`napi_bindings.rs` 对 `session` 零引用。M1c：`quiescence_depth` + `held_admissions` + `settled()`
（v2 落点 `:308-333`、`:376-406`）+ `host/telemetry`（`:547-623`）。M1d：`host/list_tools`
消掉 `buildTools` 一次性快照（`:1092`）+ 删 `executeTurnViaEngine`。量级：连续会话一到两周。

**口径 B —— P33 终态：`agent-core-v2` 从仓库消失**（M3/M4/M5）。没有 Rust 对应物、或只有一半的 v2 域：

| 域 | v2 行数 | Rust 侧现状 |
|---|---|---|
| tower | 3,535 | 无 |
| transcript 投影 | 3,363 | 无（若永久留在宿主层，即「v2 未被删除」） |
| profiles + subagent | 3,933 | Rust 有 1.6k 行实现，但**不在产品路径上**（见 G-8） |
| skill | 2,882 | 部分：`tools/skill.rs` 331 行只读，经 `state_read` |
| media / 图片压缩 | 2,461 | 无——明确宿主所有（`tools/mod.rs:423`） |
| task runner | 2,331 | 部分：`storage/task_runner.rs` 600 行 |
| context memory + 对话时钟 | 2,054 | 无 |
| permission 策略链 | 1,803 | 部分：`permission/mod.rs` 517 行，依赖宿主 `PolicySnapshot` |
| external hooks | 1,419 | 无 |
| session index / 持久化 | 1,327 | 无（宿主） |
| undo + checkpoint | 527 | 无——只有 `undoable` 线位标记 |

量级：保守为已投入的 **2–4 倍**，且卡在两个未决设计问题上——M3 的宿主分层（tower/swarm/lsp/run_code
在 v2 删除后无处安放，P33 风险条目 `:1596` 已承认）与 M4 的数据迁移 + 状态存储位置。

### 本轮的三处结论：一处新增、两处是对既有条目的量化/边界补充

**G-8（新增）工具名级平价缺口，并暴露一条隐式匹配规则。** `NativeToolset::handles`（`tools/mod.rs:186`）
按 `tool_name.to_ascii_lowercase()` 匹配，且同时列 snake_case 与 collapsed 两种写法——所以 v2 的
`WaitFor`→`taskwait` 能命中，而这些 v2 注册名**命不中**：`Agent`、`AgentSwarm`、`ReadMediaFile`、
`select_tools`、`run_code`、`lsp`、`session_query`、`Tower*`（11 个），外加**全部 MCP 运行时发现工具**
（与 `buildTools` 一次性快照叠加，turn 中途的工具集变化传不到引擎）。反向：Rust 的
`invoke_subagent` / `manage_subagents` / `define_subagent` / `list_directory` 四组在产品命名下永不命中，
只在 REPL 自建工具表（`build_repl_tool_defs`）里可达——即 `subagent/manager.rs`(1,119) +
`tools/subagent_tools.rs`(478) = **1.6k 行不在产品路径上**。两侧命名至今没有一份对照表，
这条匹配全靠大小写折叠巧合成立，属应显式化的契约。
⚠️ **本段多处论断已被 P37 的契约实测修正**：`WaitFor` 从未命中（`waitfor` 不在 `handles()` 里）、
`list_directory` 连 REPL 都没有 def、`ReadMediaFile` 已并入 Read 不再是注册工具、
Knowledge/Team/run_code/lsp/session_query 在 v2 侧不可达（模块无人导入）。见 P37 与
`tool-name-contract.json` 的 notes。

**G-6 的量化补充：否决链的完整清单。** G-6 原文只说原生路径「绕过宿主工具生命周期」；本轮把范围量清了——
`onBeforeExecuteTool` 的注册方共 **9 个文件 / 13 处**：`permissionGateService.ts:30`、
`toolDedupeService.ts:190`、`staleGuardService.ts:57`、`planService.ts:97`、`btwService.ts:34`、
`agentExternalHooksService.ts:162`、`goalAgentRuntime.ts:1295,1296`、`swarmService.ts:45,63`、
`towerService.ts:105,118,132`。Rust 原生执行只走 `host/check_permission`（`authorize` 不触发该事件）。
「不触发」≠「行为缺失」：plan-mode 写拦截已在「替换 v2 第 6 轮」落进 Rust，那条是等价实现；
其余需逐项判定「迁到引擎 / 明确接受不触发」，否则 M5 删 v2 时会连钩子一起消失。

**对 P33「`onDidFinishStep` 从不执行」条目的边界补充。** 该缺陷已于 2026-08-31 修复
（`00d7b8f4a8`：引擎返回后补跑 `runAfterStep`），且该节 `:1419-1423` 已更正过「跨 turn 压缩从不触发」
的过度论断——本轮复核确认两处都成立。需要补的是**频率边界**：修复达成的是「每 turn 一次」，
而 JS 路径是「每步一次」（`executeLoopStep :930` / `:960`）。门内语义本身是 per-step 的参与者因此在
引擎路径上被粗化：toolDedupe 的相邻调用去重、externalHooks 的 PostToolUse、以及**turn 内**的
压缩检查与提醒补注入（跨 turn 的那部分已在 turn 开始生效）。这不是新缺陷，是 M1 完成度与
`host/step_finished` 需求强度的说明：它补的是「步内」这一层，不是「有没有跑钩子」。

### 未核实项（下轮补，勿当结论引用）

- 各域行数是 `src/` 目录级 `wc -l`，含类型与测试辅助，作为量级参考够用，不是净迁移量。
- G-8 的 v2 工具名清单来自 `name = '...'` 字面量抽取（含错误类名噪声），已交叉核对到
  「命中/不命中」结论级，但未逐条对照 v2 工具注册表的最终全集。
- `swarm/`、`mcp/`、`session` 在 `napi_bindings.rs` 零引用是实测；「仅 REPL 可达」的结论未覆盖
  `main.rs` 之外的其他潜在装配点。

### 结论与排序建议

口径 A 是**做完就有真价值**的一段：引擎拥有 turn、v2 loop 退成门面，且功能等价可测。
建议顺序：**G-5 → G-8 → G-6 逐项判定 → M1c → M1d → M2**。
G-5 排最前的理由：它是 M1 与 M5 退出标准的载体，而当时**完全是空的**——`/status` 面板没有 engine 行、
`nativeToolsStatus()` 零代码调用点且探的是 `kimi-native-tools` 而非 `kimi-agent`、
`vitest.config.ts` 也没有覆盖率阈值。P33 的验收口径明确写着「不靠人工判断」，没有观测出口就无从判断。

> ✅ 本节写完后同日的 P35 已落地观测出口：`/status` 的 Engine 行取代了那个失效探针。
> 剩余的是覆盖率断言那一半，见 P35「G-5 仍未完成的部分」。

## P35 — G-5 用户可见的一半：`/status` 报出这一轮到底是谁在执行（2026-09-01）

P24 把执行路径做成了「程序可读」，`/status` 那一半留给本轮。同时 P34 确认 G-5 的门禁仍是空的，
所以这轮先补观测出口，覆盖率断言留后。

### 落点选择：宿主回调，不劫持引擎函数

最初实现是**在 app 侧包装 `TurnEngine`**（拿到 result 后记账）。实测放弃：`createRunTurnOverride`
返回的函数对象在 `rust-engine.ts` 与 `rust-loop.test.ts` 里被 **9 处**断言「宿主拿到的就是适配器返回的那个」
（`resolves.toBe(engine)`），包装会打断全部 9 条，而那些身份断言本身是有意义的——它保证 app 不偷偷改引擎。
改为给 `RustEngineOptions` 加一条 `onTurnResult?`（与既有 `getPolicySnapshot` / `nativeLlm` 同类的
「宿主注入回调」），适配器在唯一出口处调用一次。**适配器仍是引擎调用的唯一所有者。**

### 三处判定的理由

- **`activeEngineMode()` 只读不解析**：`initEngine()` 会按 napi→stdio 顺序真去装载/起子进程，
  一次状态读取绝不能触发它。所以访问器直接返回 `engineMode`，`'js'` 的含义是「还没有任何传输跑过这轮」
  或「stdio 崩到重启上限回落」，二者都不伪造传输。
- **行文案分三态**，宁可少说不猜：未记录过决策 → **整行省略**（`engineExecution()` 返回 `undefined`，
  比如不经过 app 装载路径的宿主）；已接线未跑 → `rust (wired, no turn yet)`；跑过 →
  `rust | napi | llm native-http | native tools: 3`。`nativeToolCallCount` 用 `!== undefined` 判定，
  **0 是事实不是缺值**（全宿主执行的回合就该显示 0）。
- **删掉 `nativeToolsStatus()`**（`native-require.ts`）：零调用点，且它探的是
  `@moonshot-ai/kimi-native-tools`（addon 能否加载）而非 `@moonshot-ai/kimi-agent`，注释还写着
  「shown in the `/status` report」——那行从来不存在。连带删掉三个从未被渲染的 i18n 键
  （`nativeToolsLabel/Rust/Js`），换成真正用上的 `engineLabel/engineJsLoop/enginePending/engineLlm/engineNativeTools`。

### 快照放在哪一层

`apps/kimi-code/src/utils/engine-execution.ts`：纯数据快照，不含引擎类型、不 import 引擎图
（`rust-engine.ts:215` 的既有约束：静态引入 `rust-loop` 会把整张 v2 依赖图拽进来）。
CLI 写、TUI 读，与 `experimental-flags.ts` 的「app-local snapshot + 命令侧同步读」同一模式；
组件仍只从 options 拿值，不碰 SDK。

### 验证

- `rust-loop.test.ts` **54/54**，其中真 stdio 端到端那条新增 `observed === result` 与
  `nativeToolCallCount >= 1` / `llmTransport === 'host-proxy'`——**跑的是真二进制**（日志有
  `kimi-agent ready`），证明回调在真实 turn 上真的触发，不只是 mock 里被调用。
- `apps/kimi-code`：`status-panel.test.ts` 10/10（新增 5 条覆盖三态 + 0 值），
  `rust-engine.test.ts` 23/23（新增「declined 记 js」「observer 记 napi/native-http/2」两条，
  原 9 条 `toBe(engine)` 身份断言全部保持通过）。
- `bun run typecheck` 全包 0 错误；oxlint 变更文件 0 error；locale 键与占位符检查全绿。
- 已知噪声：`bun --bun run test` 全量并行下 `apps/kimi-code` 有负载相关失败（一次 6 条、一次 1 条，
  且 `main.test.ts` 的失败点是 `globalThis.Bun` **还原时**赋只读属性），单跑这批文件时失败集合就变了——
  与本批无关，未顺手修。

### G-5 仍未完成的部分

- ~~覆盖率断言~~ → ✅ 已由 P36 落地（`check-engine-zero-js-loop.mjs`，CI lint job 门禁）。
- 快照只存**最近一轮**：多 agent / 子会话不分行显示，遥测仍是 `engine_turn` 一条不落盘事件。
- `/status` 的 Engine 行只在同进程内有值；`kap-server` / web 侧读的是 `SessionStatus`，
  那里没有 engine 字段（本轮刻意不动协议）。要跨进程可见就得走 `SessionStatusResponse` + wire，属 M2/M3。

## P36 — G-5 收尾：覆盖率断言（2026-09-01）

「`engine: 'rust'` 下零 v2 loop 代码执行」从人工判断变为机器证明。P35 落了观测出口，本轮落门禁。

### 机制

- **载体**：`packages/agent-core-v2/test/agent/loop/rustEngineZeroJsLoop.test.ts` —— 两条纯 stub
  引擎路径测试（单步 turn + 多步工具往返），文件内**禁止**出现 JS 路径测试（会污染断言所依赖的覆盖率，
  文件头有说明）。不用 `rustEngineE2E.test.ts` 当载体：它依赖真 napi addon，CI 未构建时整文件 skip，
  断言会空转。
- **断言**：`packages/agent-core-v2/scripts/check-engine-zero-js-loop.mjs` —— 从仓库根以
  `bun x --bun vitest run <载体> --coverage --coverage.include=loopService.ts --coverage.reporter=json`
  跑载体，解析 Istanbul 报告的 fnMap，按「源码声明行 → fnMap decl 行匹配 → `f[id]` 调用命中数」断言：
  - `JS_ONLY_FUNCTIONS`（8 个，P34 口径的 JS 独占函数：`executeLoopStep` / `beginStep` /
    `appendResponseContent` / `appendInterruptedStreamContent` / `executeStepTools` / `finishStep` /
    `emitStepCompleted` / `createStreamPartHandler`）命中数必须为 **0**；
  - `ENGINE_PATH_FUNCTIONS`（`executeTurnViaEngine` / `buildEngineInput` / `runAfterStep`）命中数必须
    **> 0** ——防空转假通过（本轮它真的拦下过一次脚本自身的解析 bug）。
  - 函数名从源码正则定位声明行，改名/移动而不同步清单会**显式失败**（contract drift），不会静默放过。
- **接线**：`packages/agent-core-v2` 的 `check:engine-zero-js-loop` script；CI 落在 `lint` job
  （单次运行，不随 5 分片重复；lint job 已有 bun install，增量约 20s）。

### 实现中修正的两个认知

- **v8 coverage 在 Bun 运行时下可用，但必须从仓库根跑**：从包目录 `bunx --bun vitest` 时 worker fork
  直接崩（`suppress-warnings.cjs` 被 Bun 解析器误当依赖名 `@G:/...`），从根目录跑则正常——CI 的
  `bun --bun run test` 从根跑，不受影响。
- **Istanbul fnMap 的类方法全是 `(anonymous_N)`**，按函数名匹配不可行；改按「源码声明行 = fnMap decl 行」
  定位。另有一条 `139:7 → 1954` 的类声明级巨型语句（hits=3），任何「语句相交」式行映射都会把整个类体
  判成已覆盖——这就是放弃行级断言、改用函数级命中数的原因。

### 验证

- 正向：`bun run check:engine-zero-js-loop` → OK（8 个 JS 独占函数 0 命中，3 个引擎路径函数有命中）。
- 反向：往载体临时注入一条 JS 路径测试（`createTestAgent()` 无引擎 + `mockNextResponse`）→ FAIL，
  精确点名 `executeLoopStep` / `beginStep` / `appendResponseContent` / `executeStepTools` / `finishStep` /
  `emitStepCompleted` / `createStreamPartHandler` 各 ran 1 time(s)；撤销后恢复 OK。
  `appendInterruptedStreamContent` 未被点名是正确行为——成功 JS turn 不经过流中断分支，断言按函数逐个判定。

## P37 — G-8：工具命名契约显式化（2026-09-01）

`NativeToolset::handles` 与 v2 工具注册名之间的匹配此前全靠大小写折叠巧合，两侧没有一份对照表。
本轮把契约落成单一事实源 `packages/kimi-agent/tool-name-contract.json`，双侧测试钉死，并借此
修正了 P34/batch4 报告里的四处失真。

### 契约结构（单一 JSON，双侧校验）

| 段 | 数量 | 语义 |
|---|---|---|
| `v2Native` | 23 | v2 注册名 → 引擎原生执行（`handles()` 接受） |
| `v2Host` | 15 | v2 注册名 → 回传宿主（`WaitFor` / `Agent` / `AgentSwarm` / `select_tools` / Tower 11 件） |
| `replOnlyNative` | 7 | 仅 REPL 工具表可达的原生工具（`invoke_subagent` 三件 / `TaskWait` / `list_directory` / `Knowledge` / `Team`） |
| `unloadedInV2` | 3 | 代码里存在但**任何 import 路径都加载不到**的工具（`run_code` / `lsp` / `session_query`） |
| `v2Github` | 34 | GitHub 家族，钉住 v2 注册集 ↔ 引擎 `github::is_github_tool` SPECS 表 |
| `aliases` | 21 | `handles()` 接受但无定义方使用的 snake 拼写（`subagent/manager.rs` allowlist、`permission/mod.rs`、`repl/mod.rs` 在用，**不可剪枝**） |

### 双侧钉死

- **Rust**（`tools::tests::native_tool_names_match_the_contract_file`）：`handles()` 重构为遍历
  `NATIVE_TOOL_NAMES` 常量（51 个拼写，行为不变）；测试断言契约各段与 `handles()` /
  `is_github_tool` 逐名一致，且 `NATIVE_TOOL_NAMES` 集合 == `lowercase(v2Native) ∪ replOnlyNative ∪ aliases`
  ——引擎侧多接受或少接受任何名字都会失败。
- **TS**（`agent-core-v2/test/agent/toolRegistry/toolNameContract.test.ts`）：v2 侧从**真实注册面**枚举
  ——App scope 装配（全 flag 开）后经 `AgentToolContribution` collection 探针读全量贡献，非手抄清单。
  三条断言：未分类的新工具必须失败（unclassified）、契约里的退役工具必须失败（phantom）、
  `unloadedInV2` 里的工具重新出现必须失败（resurrection）。

### 借契约修正的四处失真（P34 G-8 与 batch4 报告）

1. **`WaitFor` 从未命中原生**：v2 注册名是 `WaitFor`（`taskWaitTool.ts:326`）→ `waitfor`，
   `handles()` 只有 `taskwait`/`task_wait`。P34 的「`WaitFor`→`taskwait` 能命中」是错的——
   WaitFor 一直走宿主。原生孪生是 REPL 的 `TaskWait`（`task_tools.rs:611`）。
2. **`list_directory` 连 REPL 都不可达**：`build_repl_tool_defs` 没有它的 def，任何地方都没有——
   纯「可原生执行但无广告」的死能力。P34 的「REPL 可达」是错的。
3. **`ReadMediaFile` 不是注册工具**：Read 内部处理媒体（`readTool.ts:308`），名字只残留在
   权限表（`matchesRule.ts:82`、`default-tool-approve.ts:9`）和 TUI 渲染器。P34 把它列为 v2 注册名是错的。
4. **Knowledge / Team / run_code / lsp / session_query 在 v2 侧不可达**：knowledge-tool.ts 与
   teamTool.ts 自注册但**没有任何模块导入它们**；codeRuntimeFeature / lspFeature / sessionQueryFeature
   同样无人导入（只有 errors 模块进 errors.ts）。batch4 评估把它们当活体 v2 工具评估直移——
   前提不成立。REPL 侧 Knowledge/Team 有原生孪生（`repl/mod.rs:319-320`），故归 `replOnlyNative`；
   另三个连原生臂都没有，归 `unloadedInV2`。

### 实现中确立的两个口径

- **注册面 ≠ 激活面**：`IAgentToolRegistryService.list()` 是「默认 profile + `when` + policy 过滤后」
  的激活面（GitHub 工具 `when: hasGitHubToken`，测试环境无 token 就不激活）。契约枚举的是**注册面**——
  经 `AgentToolContribution` collection 探针读取（静态 `registerAgentToolService` 通道与 feature
  `contributeTool` 通道的统一视图，`towerFeature.test.ts:49` 的 `collectionViewOf` 同款机制）。
- **两条注册通道**：静态通道进模块表（`getAgentToolContributions`），feature 通道只进 DI collection——
  只读静态表会漏掉全部 24 个 feature 工具（cron 3 / skill / todo / goal 4 / plan 2 / swarm / tower 11 /
  codeRuntime / lsp / sessionQuery）。探针服务注入 collection 是既有测试模式（`debug.test.ts:63`）。

### 验证

- `cargo test --lib` 815 全绿（含新契约测试；`test_github_token_env` 有一次并行 env 相关 flaky，
  单跑即过，与本批无关）；`cargo clippy --lib` 0 警告；`cargo fmt --check` 干净。
- TS 契约测试绿；`tsc` 0 错误；oxlint 0 error。
- 反向：契约加幽灵名 → TS phantom 与 Rust `handles()` 断言双双失败并点名；撤销后恢复绿。
  引擎侧多接受名字（改 `NATIVE_TOOL_NAMES` 不同步 JSON）→ 集合相等断言失败。

## P38 — G-6：否决链 13 处注册方逐项判定（2026-09-01，本轮只判定，未改码）

先立一个 P34 没有的关键事实：**引擎路径下，宿主执行的工具仍过完整否决链**。
`buildEngineInput.executeTool`（`loopService.ts:1102`）走 `this.toolExecutor.execute(...)`——
`onBeforeExecuteTool` 全链照常触发。真正绕过否决链的只有 `handles()` 命中、引擎进程内原生执行的
工具名（`tool-name-contract.json` 的 `v2Native` 23 个 + GitHub 34 件）。G-6 的缺口面因此从
「13 处全部失效」收窄为「守护对象含原生工具名的注册方」。

### 逐项判定表

| # | 注册方 | 守护语义 | 引擎路径现状 | 判定 |
|---|---|---|---|---|
| 1 | `permissionGateService.ts:30` | 全工具权限裁决（mode/rules/policies/交互审批） | 宿主执行工具：钩子触发 ✓。原生工具：本地 `PermissionEngine`（PolicySnapshot 镜像）+ 变更类 Ask 上抛 `host/check_permission` → `gate.authorize` 全机制 | **等价**——权限权威仍在宿主（P33 契约），本地链保真度是 P26 批 3 自身的测试面 |
| 2 | `toolDedupeService.ts:190` | 相邻重复调用去重（veto 合成结果） | 宿主执行工具：触发 ✓。原生工具（恰是最常重复的 Read/Grep）：不触发；且步界粒度已粗化（P33：per-turn） | **缺口 → M2 迁移**：引擎 `run_turn` 内做 per-step 去重（状态在引擎侧，天然归属） |
| 3 | `staleGuardService.ts:57` | Edit/Write 写前读检查（盲写防护） | 原生 Write/Edit 绕过；Rust `write()` 无任何 stale 检查（`tools/mod.rs`） | **缺口（高价值）→ M2 迁移**：数据保护；Rust Edit 的 old_string 匹配天然防盲改，Write(overwrite) 是裸奔面 |
| 4 | `planService.ts:97` | plan 模式 Write/Edit 拦截 + ExitPlanMode 审批 | ~~REPL：`plan_guard` 等价 ✓（`repl/mod.rs:455`）。**napi 产品路径 `plan_guard: None`（`napi_bindings.rs:1093`）→ plan 模式下原生 Write/Edit 不被拦截**；权限策略链无 plan 概念（grep 证实），宿主 `check_permission` 兜不住。ExitPlanMode 审批：原生 `exit_plan_mode.rs` 已实现完整审批流（经 `ask_question`，auto 直通）~~ **✅ 已落地（2026-09-01，见 P39）**：`PlanGuard` 异步化，napi/stdio 产品路径经 state 桥每次受护调用现读 plan 状态并按 v2 语义否决（Write/Edit 只许写 plan 文件 + TaskStop/CronCreate/CronDelete 拒绝，后两项同时补齐了 REPL 缺口）；ExitPlanMode 审批原本已由原生工具自带 | **已迁移** |
| 5 | `btwService.ts:34` | btw 子代理禁用全部工具 | 子代理 loop 同样拿到 engine override → 原生工具绕过 veto | **缺口（低危）→ 接受并记录**：reminder 已声明禁用，veto 是执行保障；引擎侧补「工具禁用」通道属 M2 可选项 |
| 6 | `agentExternalHooksService.ts:162` | 用户配置 PreToolUse 钩子（可 veto） | 原生工具不触发（P33 已记「零对应」） | **缺口（用户可见）→ M2 迁移**：Rust 侧执行 PreToolUse 命令；迁移前在文档标注「原生路径不触发用户钩子」 |
| 7 | `goalAgentRuntime.ts:1295` | CreateGoal 启动审批（非 auto 模式） | CreateGoal 原生（走 state 桥）→ 审批 ask 不触发，goal 静默启动 | **缺口 → M2 迁移**：审批需宿主 ask 通道（`host/ask_question` 已存在，可承载） |
| 8 | `goalAgentRuntime.ts:1296` | 陈旧 goal 工具调用合成结果 + 预算宽限轮拒绝 | 原生 goal 工具（4 个全在 `handles()`）绕过 → 保护失效 | **缺口 → M2 迁移**：引擎自带 goal driver，stale/budget 状态在引擎侧，天然归属 |
| 9 | `swarmService.ts:45` | swarm 模式禁 `Agent` | Agent 是宿主工具 → 钩子照常触发 | **等价**——无需动作 |
| 10 | `swarmService.ts:63` | AgentSwarm 批次约束（单步至多一个） | AgentSwarm 是宿主工具 → 触发 | **等价**——无需动作 |
| 11 | `towerService.ts:105` | flag 关时 Tower 工具惰性 | Tower 工具是宿主工具 → 触发 | **等价**——无需动作 |
| 12 | `towerService.ts:118` | tower 模式禁 TodoList | TodoList 原生 → 绕过 | **缺口（实验特性，低危）→ 接受并记录**，随 tower 的宿主分层决策（M3）一并处理 |
| 13 | `towerService.ts:132` | tower worker profile 的 Write/Edit 限制 | Write/Edit 原生 → 绕过 | **缺口（实验特性）→ 随 M3 tower 决策处理** |

### 结论

- **4 处等价**（#1、#9、#10、#11）：守护对象是宿主工具（钩子照常触发）或权限（`check_permission`
  全机制承载）。无需动作。
- **2 处接受并记录**（#5、#12）：低危（reminder/实验特性已兜住语义），M5 删 v2 时按本表显式接受，
  不算静默丢失。
- **7 处真缺口 → 迁移队列**：~~#4（plan 拦截 napi 接线，**产品默认路径缺陷，排最前**）~~ ✅ 已落地（P39）、
  #3（staleGuard）、#7+#8（goal 审批/stale，同域一并做）、#6（externalHooks PreToolUse）、#2（toolDedupe）、
  #13（tower worker，随 M3）。每项独立成批，落地一项即在 Rust 侧补测试并在本表销账。

### 验证说明

本任务为只读判定，未改任何 src/ 文件。全部结论基于代码阅读：`toolHooks.ts`（veto/allow/pass/waitUntil
语义）、13 处注册点、`loopService.ts:1102-1163`（engine input 的 executeTool/checkToolPermission 接线）、
`callbacks.rs:402-443`（原生执行门：plan_guard → permission_engine → check_permission）、
`napi_bindings.rs:1073-1099`（产品路径装配，`plan_guard: None`）、`permissionPolicy/policies/*`
（无 plan 策略）、`repl/mod.rs:448-458`（REPL plan_guard 接线）。

## P39 — G-6 队列头：plan 拦截接入产品引擎路径（2026-09-01）

P38 判定的 #4 落地：plan 模式 Write/Edit/TaskStop/CronCreate/CronDelete 拦截从「仅 REPL」扩展到
napi 与 stdio 产品路径。**零 wire 改动**——guard 经既有 state 桥（`host/state_read {domain:"plan"}`）
在每次受护原生调用前现读 plan 状态，与 REPL 每调用读本地 store 的语义一致，且天然覆盖 turn 中途的
EnterPlanMode/ExitPlanMode（per-turn 快照方案会在这里变脏，故弃用）。

### 落码

- **纯函数**（`tools/plan_mode.rs`）：`plan_guarded_tool`（受护工具集，双拼写）+ `plan_denial`
  （v2 `guardToolExecution` 决策：plan 激活时 Write/Edit 只许写 plan 文件、TaskStop/CronCreate/CronDelete
  拒绝；路径按组件比较——宿主 plan path 与模型参数可能混用 `/`/`\`；plan path 缺失时拒绝全部写，
  文案带 `(no plan file selected yet)`，对齐 v2）。
- **`PlanGuard` 异步化**（`callbacks.rs`）：`dyn Fn(&str, &Value) -> BoxFuture<Option<String>>`；
  调用点 `.await`。guard 拒绝路径补发 `tool.native` 事件（与权限拒绝同一契约：refusal 是模型看到的
  结果，transcript 必须记录卡片终态）。
- **三条路径接线**：REPL 闭包包异步（本地 store 现读）；napi（`napi_bindings.rs`）与 stdio（`main.rs`）
  闭包经 `base_callbacks.state_read` 现读——`plan_guarded_tool` 早退让非受护工具（Read/Grep 等高频调用）
  零额外往返；state 读失败 fail-open（与 REPL `.ok()?` 一致，变更类工具仍有权限层兜底）。
- **顺带修正**：REPL guard 原本缺 CronCreate/CronDelete 否决（v2 有）——纯函数统一后两条路径都补齐。

### 验证

- `cargo test --lib` 824 全绿（新增 8 个 `plan_denial` 单测：激活/未激活、plan 文件放行、
  相对路径解析、无 plan path 拒绝、TaskStop/Cron 双拼写、受护集边界）；REPL guard 测试补 Cron 用例。
- **stdio 端到端**（`stdio_rpc_integration.rs` 新用例）：plan 激活 + 原生 Write 到非 plan 文件 →
  guard 先于权限轮询否决（`permission_requests` 为空）、state 桥恰一次 plan 读、`tool.native`
  事件携带拒绝文案、磁盘无文件、不回退宿主。10/10 全绿。
- `cargo clippy --lib --all-targets` 0 警告；`cargo fmt --check` 干净；bun 侧 97 passed（无 wire 改动）。
- 已知噪声：`test_github_token_env` 一次并行 env flaky（单跑即过，P37 已记录同类）。

## P40 — 产品决策：TS 引擎显式禁用，门禁改 rust-only（2026-09-01）

P19 的 rust-first 默认（unset → rust，bundle 缺失静默回退 JS）走到头了：回退把 rust 引擎的
故障掩埋成「悄悄变慢的 JS」。本决策把 TS agent 引擎从「隐式兜底」改为「显式禁用」——
rust bundle 缺失或损坏是启动错误，不再静默跑 JS loop。

**决策修订（同日补）**：初版保留了 `agent.engine = "js"` 作为显式逃生门；复核后撤掉——
迁移期不需要过渡档位，`"js"` 一律忽略（打印警告），TS 引擎在整个迁移期间不可运行。
枚举值保留（旧 config 不炸），但门禁不再赋予它任何语义。

### 门禁语义（`apps/kimi-code/src/cli/rust-engine.ts`）

- `agent.engine = "js"` → **忽略**（`console.warn` 提示值已废弃），照常走 rust 门禁——
  没有逃生门，multiLlm 照常生效（原「multiLlm set but engine not active」警告随之删除）。
- `agent.engine = "rust"` 或 unset（默认）→ rust 引擎**必需**：
  - bundle 不可加载 → 抛错（修复指引：构建 native bundle）；
  - 配置不可读 → 视同 unset（无法表达引擎偏好时走默认 = rust）；
  - adapter 模块缺 `createRunTurnOverride`、或 `createRunTurnOverride` 抛错/返回 undefined
    （gate 已确认 bundle 可加载，双传输 init 失败 = 安装损坏）→ 抛错，不再吞掉。
- 调用点（`run-shell.ts` / `run-v2-print.ts`）兜底：打印错误 + `process.exit(1)`——
  顶层 `main()` 无 catch，不兜底就是裸 unhandled rejection。
- 原 `catch { return undefined }`（「Rust adapter not available — fall back to JS」）删除；
  `maybeLoadRustEngine` 的 `setEngineExecution({ rust: false })` 分支随之死亡，一并删除
  （`/status` 快照不再有 `{ rust: false }` 态）。

### 验证

- `rust-engine.test.ts` 26 全绿：unset/rust + bundle 缺失 → 抛错（3 条）、`"js"` 忽略 +
  警告（bundle 缺失照抛 / bundle 可加载照接线 / 快照记 rust / multiLlm 照常生效，4 条）、
  adapter 无引擎/抛错 → 上抛不回退（2 条）、config 不可读视同 unset（1 条）；
  bundle-present 默认翻转（原 fixture 默认无 bundle 是为回退路径服务的）。
- `run-shell.test.ts` 18 全绿：`#/cli/rust-engine` 整模块 mock（run-shell 测试不测门禁，
  mock 掉后真实门禁的抛错路径不会泄漏进启动测试）。
- `run-v2-print.test.ts` 只测纯函数，不受影响；`rust-engine-cli-e2e.test.ts` 显式
  `engine = "rust"` + skipIf 守卫，不受影响。

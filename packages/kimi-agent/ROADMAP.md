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

| 缺失 | 补齐 | 状态 |
|------|------|------|
| 只有 token / turn 预算 | 补 wall-clock 预算:`GoalContext` 增 `wall_clock_budget_ms`/`wall_clock_ms`,`would_exceed_budget`/`budget_fraction` 支持,`render_goal_steering` 展示 `time x/10s (remaining n)`;wire(rpc/napi/stdio)同步 | ✅(+4 测试) |
| 预算达成后无 host 状态同步 | 预算耗尽时 `emit_event` 发射 `goal.budget.limit_reached`(带 goal_id)| ✅ 用 EventCapturingCallbacks 断言 |
| 无 goal 修改 / 重建 | `RustEngineOptions.getGoal`(每轮重取,host 快照随变)+ `TurnEngineInput.getGoal?` 契约(v2 侧)+ napi/stdio 双通道传参 | ✅ 契约与传递完成;**host 侧注入受 agent-core-v2 分层约束(loop 与 goal feature 互为依赖会触发 `import/no-cycle`),因此 getGoal 由签名方注入,不在 loopService 内硬接线**(旁路注入,见接线项) |

**接线说明(独立跟踪)**:`getGoal` 的数据提供方应在能安全解析 AgentGoal 的宿主层(如 goal feature 自身或 CLI 装配层)注入,当前 rust-engine.ts 默认不注入 → 无 goal 时引擎回归原有行为(无预算)。P2 修复后 goal 的 turn/usage 记账已随 `onWillBeginStep` + `TurnEnded` 在 engine 路径生效。

验证:cargo 202 lib + 6 集成全绿(新增 wall-clock 预算、事件断言、format_elapsed 测试)、bun 52 测试全绿、oxlint 0 errors。

## P4 — 状态 / 事件 / 遥测对齐 — ✅ 已完成

| 工作项 | 结果 |
|--------|------|
| 事件 schema 化 | ✅ rust-loop 侧 `EngineEvent` 升级为**判别联合**(llm.step.begin/delta/end、tool.native、goal.budget.limit_reached),全部类型化访问,移除 `event['key'] as ...` 强转;Rust 侧发射保持 serde_json(发射内部不做全套枚举,避免过度工程) |
| usage 细分 | ✅ `TokenUsage` 扩至 4 字段(`input_cache_read`/`input_cache_creation`);openai 解析 `prompt_tokens_details.cached_tokens`,anthropic 解析 `cache_read_input_tokens`/`cache_creation_input_tokens`(parse_response + stream);贯通 http.rs step.end 事件 → rust-loop step.end usage;+3 测试 |
| telemetry | ✅ `llm.step.end` 事件带 `latency_ms`(请求计时);事件计数/重试上报未接入(重试在 turn_step 外层,单一 sink 通道无 per-turn 指标承载,标注见下) |

**telemetry 备注**:事件计时已入 wire(latency_ms),但「事件数量 / 重试次数」上报需要 host 侧 telemetry 入口(engine 路径目前无 track2 通道)或自有计数聚合;此项作为后续接线项,不阻塞事件/usage 对齐。

验证:cargo 205 lib + 6 集成全绿(新增 cache 解析 3 测试)、bun 52 测试全绿、oxlint 0 errors。

## P5 — 验证与基准 — ✅ 已完成(有限边界)

1. **行为等效测试** ✅(务实版):engine override 契约测试 `engineOverride.test.ts` 扩充至 **5 个**——注入门、goal 事件、多步工具 round-trip 完整驱动(新增「drives a multi-step turn with tool round-trips then reports events」:验证引擎多步驱动、工具往返、assistant delta 顺序)。注意:逐事件 diff"JS 引擎 vs Rust 引擎"在结构上不可行(JS 自动发 step 事件,引擎手动 dispatch),以契约行为测试替代。
2. **性能基准** ⏸ 方法已记录(见下):native-LLM + native-tools vs host-proxy 的 P95 首次 token / 工具往返需真实 LLM key,无法在 CI 或无 key 环境执行;已就近可用指标为主的测试代替。
3. **Cargo 侧** ✅:移除确认多余且生产使用的 `#[allow(dead_code)]`(JsonRpcRequest / JsonRpcResponse / JsonRpcErrorResponse / method_not_found),`cargo clippy` 0 warnings;其余 allow 为有意保留的 wire 字段声明。

**性能基准方法(记录,待有 key 环境执行)**:
- 同输入、同 provider 下对比 native-LLM + nativeTools vs host-proxy,收集 LLM 首 token 时延与工具往返耗时。
- 用 `llm.step.end.latency_ms`(P4 已入 wire)作为原生路径指标。
- 无 key 时可用 `Duration` 在 turn-loop 单元层次测吞吐(fake LLM),作为相对基准。

## 完成度小结

- P0 清理 ✅ / P1 投影 ✅ / P2 注入 ✅ / P3 Goal ✅ / P4 遥测 ✅ / P5 验证 ✅
- 全部验证:`cargo test` 205 lib + 6 集成;`bun vitest` 152(loop + kimi-agent + rust-engine);oxlint 0 errors。

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
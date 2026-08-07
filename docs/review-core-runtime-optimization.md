# 核心运行时优化审查报告

- **日期**: 2026-08-08
- **范围**: Kimi Code CLI monorepo 核心运行时（7 个包，约 30 万行 TS）
- **维度**: 性能 / 内存 / 并发与异步（优化视角）；顺带记录安全与正确性问题
- **方法**: 静态信号扫描（Grep 反模式）+ 7 个并行 explore 子代理逐包精审 + 主 agent 抽查复核
- **状态**: 本报告为只读审查产物，不修改任何源码

## 审查范围

| 包 | 文件数 | 代码量 | 说明 |
|---|---|---|---|
| `apps/kimi-code` | 315 | ~6.3 万行 | 主 CLI/TUI 入口 |
| `packages/agent-core` | 387 | ~7.5 万行 | v1 agent 引擎 |
| `packages/agent-core-v2` | 804 | ~11 万行 | v2 引擎（DI×Scope） |
| `packages/kosong` | 31 | ~1 万行 | LLM/provider 抽象 |
| `packages/kaos` | 11 | ~3 千行 | 执行环境抽象 |
| `packages/kap-server` | 135 | ~2.9 万行 | 本地 REST+WS 服务器 |
| `packages/klient` | 47 | ~5 千行 | 客户端 SDK |

未覆盖：vscode / vis / kimi-inspect / web UI、Rust 源码本体、文档与测试基建。

## 结果汇总

| 包 | CRITICAL | MAJOR | MINOR | NIT |
|---|---|---|---|---|
| apps/kimi-code | 0 | 3 | 6 | 4 |
| packages/agent-core | 0 | 7 | 14 | 2 |
| packages/agent-core-v2 | 0 | 4 | 5 | 4 |
| packages/kosong | 0 | 5 | 5 | 5 |
| packages/kaos | 0 | 2 | 8 | 6 |
| packages/kap-server | 0 | 8 | 13 | 5 |
| packages/klient | 0 | 3 | 8 | 3 |
| **合计** | **0** | **32** | **59** | **29** |

**总体结论**：工程整体质量高——异步 IO 规范、订阅清理普遍走 Disposable、缓存/节流/批量写等模式大量正确落地，**未发现 CRITICAL 级（崩溃/数据丢失/严重安全）问题**。优化空间集中在三类系统性模式：

1. **热路径"每事件全量重算"**（streaming 参数重解析、config 每次全量重建、transcript 每请求全量折叠）
2. **无界增长**（MCP 监听器、broadcaster session state、shell outputTail、hub 强引用）
3. **序列化/IO 重复**（RPC 每 chunk 双重 JSON、native fast-path 双重请求、每请求 statSync）

下文先列跨包 Top 发现，再按包给完整清单。

---

## 跨包 Top 发现（按影响排序）

### T1. [MAJOR] MCP 状态监听器永久泄漏（agent-core）
`packages/agent-core/src/agent/tool/index.ts:111-125` — 每个 Agent 构造时 `attachMcpTools()` 向共享的 `McpConnectionManager.listeners` 注册 `onStatusChange`，退订函数存入 `mcpToolStatusUnsubscribe` 但**全代码库无任何调用点**（已 grep 确认仅 75/114/122 三处，无调用）。Agent 无 dispose 路径，已完成 subagent 仍留在 `session.agents`。
**影响**：长会话（大量子代理/swarm）下监听器与完整 Agent 对象图无界增长；MCP 状态变化时 `emit()` 需遍历所有历史子代理监听器。
**修复**：Agent 增加 dispose 并在回收已完成子代理时调用，或任务终结时执行退订。

### T2. [MAJOR] IPC stream 转发无视 socket 背压（klient）
`packages/klient/src/transports/ipc/host.ts:171-187` — stream 转发循环 `send()` 忽略 `socket.write()` 返回值，`for await` 无 `await drain`。LLM 流式时若消费端慢于引擎，socket 写缓冲无界增长、引擎被超速拉取。
**修复**：`socket.write()` 返回 `false` 时暂停拉取，`await once(socket, 'drain')` 后继续。

### T3. [MAJOR] native LLM fast-path 静默吞错 + 整请求重发（kosong）
`packages/kosong/src/providers/anthropic.ts:1144-1146`（同 `openai-legacy.ts:712-714`、`openai-responses.ts:1177-1179`）— `tryNativeLlmStream` 抛出的任何错误（429/连接失败/Rust 解析 bug）被 `catch {}` 吞掉，随后走 SDK **再发一次完整 HTTP 请求**，且零日志。
**影响**：native 链路系统性故障时每次调用发 2 个请求（成本与首字延迟翻倍）；429 场景反而放大 provider 负载。
**修复**：catch 至少 `console.warn`；加熔断（连续 N 次失败本会话跳过 native）。

### T4. [MAJOR] native 流整响应缓冲后才 yield + AbortSignal 不传递（kosong）
`packages/kosong/src/providers/native-stream.ts:149-184` — Rust 侧跑完整 HTTP 流后一次性返回，streaming 退化为"跑完再显示"。`native-stream.ts:47-55,198-236` — `NativeLlmStreamConfig` 无 signal 字段，Esc 取消最坏等 120s `timeoutMs`，期间请求照跑照计费。
**修复**：ThreadsafeFunction 逐 token 回调；config 增加 signal 传递 abort。

### T5. [MAJOR] config.get() 每次调用全量重建（agent-core-v2）
`packages/agent-core-v2/src/app/config/configService.ts:375-401, 651-696` — 非 memory domain 每次 spread 全部 validated sections + 递归 env 解析 + zod 校验 + overlay。包内 55 个文件带 `env:` 绑定。热路径调用方：`llmRequesterService.ts:584,672-673`（每请求 3 次）、`toolPolicyService.ts:72,89`（**每工具每步**）。
**修复**：`freshEffective()` 结果按脏标记记忆化（reload/revalidate/overlay 变化时失效）。

### T6. [MAJOR] 冷路径全量重算无缓存（kap-server）
`packages/kap-server/src/services/messages/messageHistory.ts:83,117,145,189` + `transcriptService.ts:573` — 每次消息/transcript 请求都 flush journal + 全量读 append log + 从零折叠全部历史 + 分页。长会话 UI 轮询时每请求 O(历史文件)。`transcriptService.ts:506` 每次 turn 结束重读整个 wire.jsonl 做 heal。
**修复**：按 journal 字节偏移增量折叠 + mtime/size 校验缓存。

### T7. [MAJOR] 每请求同步 statSync（kap-server）
`packages/kap-server/src/services/auth/tokenStore.ts:37` — `createAuthHook` 每请求 `currentToken()` → `statSync(tokenPath)` 同步 syscall，高频 REST 下每请求阻塞事件循环（NTFS 上更慢）。
**修复**：秒级 TTL 缓存 stat 结果。

### T8. [MAJOR] 长生命周期对象无界驻留（kap-server）
`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts:219,804` — `this.sessions` 只增不减（`delete` 仅在创建失败路径 838 与 `close()`），每个 state 常驻 open journal 句柄 + tail（≤1000 envelope）+ targets。daemon 激活过的 session 全部驻留。
**修复**：session 引擎关闭时 dispose state；tail 改环形缓冲。

---

## apps/kimi-code（MAJOR 3 / MINOR 6 / NIT 4）

### MAJOR

**M1. tool.call.delta 每事件全量正则重解析**
`src/tui/controllers/session-event-handler.ts:615`（+ `streaming-ui.ts:341-352`、`utils/event-payload.ts:45-71`）— 每个 delta 对 ≤64KB 参数文本做全量 `matchAll`（`STREAMING_ARGS_PREVIEW_MAX_CHARS=64KB`）+ `slice(0,64KB)` 复制，同一文本每事件解析 2-3 次；AgentSwarm 路径还经 `agent-swarm-progress.ts:262-299` 再逐字符扫描（876-894）。n 个 delta × 每次 64KB 解析 = O(n²) 累积。大参数工具（swarm items、多文件 Read）流式期间 CPU 浪费显著。
**修复**：仅对 AgentSwarm/SwarmDiscussion 工具 parse；增量解析新增尾部。

**M2. swarm 面板每次 render() 嵌套全 UI 渲染**
`src/tui/controllers/subagent-event-handler.ts:44-54`（+ 614-629、`agent-swarm-progress.ts:471-476`）— `availableGridHeight` → `renderedRowsAfterChild` 对 transcriptContainer 之后全部组件各做一次完整文本渲染只为数行数，随后 pi-tui 再正常渲染一遍 → 双重渲染。每 80ms 动画帧 + 每个 delta 事件都触发，swarm 会话期间持续。
**修复**：行数结果加 TTL 缓存（~200ms），或按 `terminal.rows - 固定估算`。

**M3. shell 输出无节流全量 strip**
`src/tui/components/messages/shell-run.ts:49-56`（+ `utils/shell-output.ts:32-44`）— 每个 `shell.output` 事件立即对 ≤256KB 缓冲做 4 个正则全量 strip + `requestRender`；`OSC_PATTERN`（`/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g`）无终止符输入最坏 O(n²)。长输出命令每秒几十块重复 strip 整个缓冲。
**修复**：50-100ms debounce；只 sanitize 新增尾部、缓存已 strip 前缀。

### MINOR

- **m1** `session-event-handler.ts:535,559` + `kimi-tui.ts:1647-1663` — 每 assistant/thinking delta 同步 `estimateTokensFromText` 全量扫描 + `setAppState({outputTokens})` → footer/activity 刷新链。可批量到 50ms flush。
- **m2** `kimi-tui.ts:1600-1602, 2277, 1186` — `transcriptEntries` 只 push 不裁剪，长会话无界增长；`streaming-ui.ts:245-304` 每 background 事件 O(n) 遍历 children。建议超阈值裁剪。
- **m3** `components/editor/file-mention-provider.ts:312-375` — `@` 补全 fallback 每次击键同步 `readdirSync`（上限 2000 entry）+ 每次 `accessSync` 探测 fd。慢盘/大目录输入卡顿。建议 1-2s TTL 缓存。
- **m4** `feedback/codebase/scanner.ts:98-115,120-169` — 逐文件串行 `await lstat`，建议有界并行（16-32）。
- **m5** `streaming-ui.ts:613-620` + `assistant-message.ts:45-71` — 50ms flush 传全文给 `markdown.setText` 全量重渲染，长消息 O(n²)。streaming 只渲染尾部，finalize 全量重渲。
- **m6** 静默吞错 — `plugin-update-notifier.ts:112,124`（有意）、`cli/update/preflight.ts:588`、`cli/run-prompt.ts:399`（权限恢复失败用户状态未知）。建议吞错分支至少 `log.warn`。

### NIT

- `kimi-tui.ts:1593-1598` — `shiftQueuedMessage` 解构复制整个队列，改 index 指针。
- `native/module-hook.ts:40-43` — 每模块加载跑 `PI_TUI_NATIVE_PATTERN.test`，可先 `endsWith('.node')` 短路。
- `utils/transcript-id.ts:1-6` — 模块级计数器永不重置。
- `streaming-ui.ts:215-270,283-305` — 事件遍历全部 transcript children，可建 agentId 索引。

---

## packages/agent-core（MAJOR 7 / MINOR 14 / NIT 2）

### MAJOR

**A1. MCP 状态监听器永久泄漏**（同 Top T1）
`src/agent/tool/index.ts:111-125` — 见 T1。

**A2. loopTools getter 每步全量重建**
`src/agent/tool/index.ts:979-1049` — turn 循环每步 `buildTools` 读取：分配多个数组/Set、`toSorted` 排序、每个工具 `{...tool, deferred:true}` 克隆；disclosure 开启时 `collectLoadedDynamicToolNames` 全量扫 history（1008 行，O(history)）。
**修复**：按"注册/配置变更"脏标记做步间缓存。

**A3. session list 路径 N+1 串行文件 IO**
`src/session/store/session-store.ts:388-397,404-411,435-440`（+519-547,909-925）— `listWorkDir`/`listAll` 逐 session `await summaryFromDir`（stat + readFile(state.json) + 3×statIfExists + readdir(agents) + 每 agent stat），全部串行。50 个 session ≈ 300+ 次串行 fs。
**修复**：`Promise.all` 并发（参考 grep.ts `mapWithConcurrency`），上限 16-32。

**A4. session 索引每次全量重读**
`src/session/store/session-store.ts:462-466` + `session-index.ts:64-100` — 每次 `findSessionEntry`/`listAll` 都 readFile 整个 `session_index.jsonl` 逐行 parse，无进程内缓存；写入端却是有本地队列的追加链。
**修复**：内存缓存索引 Map，追加时同步更新，mtime 校验。

**A5. 文件搜索整树串行 DFS**
`src/services/fs/fsSearchService.ts:107-150,567-607` — `search()` 每次请求串行 readdir 全树、收集全部候选、整体排序后切片，无并行、无提前终止、未用 native。
**修复**：目录级 `Promise.all` + 命中上限剪枝；或接入 native search。

**A6. 流式热路径每次事件两次 JSON 深拷贝**
`src/rpc/client.ts:44-56` — `simulateNetwork` 对每个调用（含每个 `emitEvent`）stringify+parse 往返 + `rpc/types.ts:26` spread。`text.delta`/`tool.call.delta` 每 chunk 都走一遍。
**修复**：小事件浅拷贝+写时复制，或 5ms 窗口微批合并 delta。

**A7. resolveProviderConfig 无缓存**
`src/session/provider-manager.ts:96-159` — 每次调用重新构造完整 kosong provider 配置 + `resolveModelCapabilities`；被每步调用（turn/index.ts:1321、agent/index.ts:442 等）。
**修复**：按 model alias 缓存（reload 时失效）。

### MINOR

- **a1** `session/index.ts:224,754,1026-1041` — `Session.agents` 随已完成 subagent 无界增长；每次 `writeMetadata` 全量序列化。[需确认是否有意保留以支持 resume]
- **a2** `agent/background/index.ts:269-270,817-820,863` — `scheduledNotificationKeys`/`deliveredNotificationKeys` 只增不删。
- **a3** `agent/records/persistence.ts:163-198` — 每批 open+writeFile+**fsync**+close 无时间窗口合并；`pendingRecords` 慢盘无界堆积。建议 10-50ms 防抖。
- **a4** `logging/sinks.ts:52-60,177-189` — `pending.shift()` O(n) 前移；每次 drain open+append+sync+close。环形索引 + 定时 flush。
- **a5** `services/fs/fsSearchService.ts:85,609-625` — `gitignoreCache` 无上限无淘汰。加 LRU（64 条）。
- **a6** `rpc/core-impl.ts:1344-1376` + `config/toml.ts:139-210` — 每次 createSession/resumeSession/fork/listSkills 同步 existsSync+readFileSync+TOML 解析+zod 校验，阻塞事件循环。按 mtime 缓存。
- **a7** `base/common/event.ts:60-70` — `Emitter.fire` 每次 `Array.from(this._listeners)` 快照。可用迭代中增删标记替代。
- **a8** `agent/index.ts:442-459` — `get llm()` 每次新建 `KosongLLM`。可缓存，config 变化时重建。
- **a9** `agent/turn/index.ts:1284-1289` — `hasPriorStepToolCallKey` 每次 tool.call 遍历所有历史 step，O(steps×calls)。建 toolName→step 反向索引。
- **a10** `services/fileStore/fileStoreService.ts:193-204` — 每次 save/delete 重写整个 `index.json`（O(files)）；`get` 不检查 `expires_at`（过期文件永不回收）。
- **a11** `session/store/workspace-registry-file.ts:129-162` — 每次 createSession 全量 read-modify-write `workspaces.json`。进程内缓存 + 防抖合并。
- **a12** `services/fs/fsSearchService.ts:274-284` — `stdoutBuf += chunk` + 逐行 slice 重建，大输出 O(n²) 字符搬运。用偏移指针。
- **a13** `session/index.ts:1101-1116` — 每个 session 创建全量 skill 根目录扫描，无跨 session 缓存。按 mtime 缓存目录清单。
- **a14** `session/subagent-host.ts:192-195,303,277-280` — 每次 spawn 构造整套 Agent 对象图（~20 个子系统），一次性子代理用完即弃。可复用轻量模板。

### NIT

- `tools/builtin/file/grep.ts:165,737-743` — `CONTENT_LINE_RE = /^(.*?)([:-])(\d+)\2/` 超长无匹配行 O(n²) 回溯风险 [需确认，content 模式不设列上限]。
- `logging/sinks.ts:54-57` — shift 丢最旧行可改头指针环形缓冲。

---

## packages/agent-core-v2（MAJOR 4 / MINOR 5 / NIT 4）

### MAJOR

**V1. config.get() 每次调用全量重建**（同 Top T5）
`src/app/config/configService.ts:375-401, 651-696` — 见 T5。`getAll()`（392-394）同样全量重建。
**修复**：`freshEffective()` 脏标记记忆化。

**V2. 工具选择路径每步 O(n²)**
`src/agent/toolSelect/toolSelectService.ts:224-247,176-182` + `src/agent/toolRegistry/toolRegistryService.ts:49-59` — `activeLoadedToolNames()` 对每个 loaded name 调 `list().find()`；`list()` 每次返回含完整 JSON schema 的新排序数组。多 MCP 工具（50-200 个）时每步开销平方增长。
**修复**：每步构建一次 name→ToolInfo Map；`list()` 缓存并在 register/unregister 失效。

**V3. 每 LLM 请求两次全量工具 JSON.stringify + sha256**
`src/agent/llmRequester/llmRequesterService.ts:646-650,662-666` — `logRequest` 和 `recordRequest` 各执行一次 `toolSignature`+`fingerprint`。工具 schema 可达数百 KB，每次请求序列化+哈希 ~1ms。
**修复**：按工具集标识/版本缓存 toolsHash。

**V4. isToolActive() 每工具每步重建 profile+config**
`src/agent/toolPolicy/toolPolicyService.ts:54-64` — 每工具每步 `profile.data()` + `config.get(TOOLS_SECTION)`；与 V1 叠加：60 工具 × 每工具 2 次全量 config 重建 ≈ 每步 120+ 次 zod 解析。
**修复**：每步快照一次 profile+config 值再批量过滤。

### MINOR

- **v1** `kosong/contract/generate.ts:88,259-261` — 流式热路径每 streamed part `structuredClone` 深拷贝。消费者需要独立副本时再克隆。
- **v2** 静默吞错多处 — `mcpCore/connection-manager.ts:504,524`、`externalHooks*`（143/69/99/134/180）、`goalService.ts:1078`、`taskService.ts:849`、`kimi-schema.ts:302,310`、`fileLog.ts:79,233`。至少 debug/warn。
- **v3** `workspaceFs/fsService.ts:333-353,374-395` — `listMany`/`statMany` 全量 `Promise.all` 无并发上限。加小并发池（32）。
- **v4** `session/agentLifecycle/profile/profiles.ts:130` + `gitContext.ts:45-100` — explore profile 每 turn 探测 git（rev-parse + 4 并行 spawn，含 `git status --porcelain`），无跨 turn 缓存 [需确认上游是否已有缓存]。
- **v5** `agent/profile/profileService.ts:576-579` — `data()` 每次分配多个数组拷贝，与 V4 合并为每步快照。

### NIT

- `llmRequesterService.ts:619-633` — getOrCreateTurnConfig 每请求遍历 Map 键清理（O(n) 摊销可忽略）。
- `configService.ts:408-416` — pushDiagnostic O(n) 去重。
- `fileLog.ts:89` — flushSync 中 appendFileSync（仅进程退出，属设计）。
- `agent/toolExecutor/toolScheduler.ts:58-61` — conflictsWithAny 每任务 O(active)（可忽略）。

---

## packages/kosong（MAJOR 5 / MINOR 5 / NIT 5）

### MAJOR

**K1. native fast-path 静默吞错 + 整请求重发**（同 Top T3）
`providers/anthropic.ts:1144-1146`（同 `openai-legacy.ts:712-714`、`openai-responses.ts:1177-1179`）— 见 T3。

**K2. native 流整响应缓冲后才 yield**（同 Top T4）
`providers/native-stream.ts:149-184`（设计注记 8-11 行自认）— `NativeStreamedMessage._parts` 一次性持有全部 token，`generate.ts:120` 等响应完全结束才返回。streaming 退化为"跑完再显示"，内存随输出线性增长。
**修复**：ThreadsafeFunction 逐 token 回调；落地前默认关闭 native 流或做 A/B 开关。

**K3. AbortSignal 不传递到 native 调用**（同 Top T4）
`providers/native-stream.ts:47-55,198-236` + `generate.ts:120,154` — 取消最坏 120s 后轮询检查才抛 AbortError，期间请求照跑照计费。

**K4. 请求级 auth 时每个 generate 重建整个 SDK client（AuthClientLRU 是死代码）**
`providers/request-auth.ts:44-99,117-141` — grep 确认全包无调用方传入 `authClientLRU`；当 `options.auth` 存在（OAuth/请求级 headers，provider.ts:146 注释正是 host 常规做法），每个 generate `new` 一个 client（anthropic.ts:1187-1193 / openai-legacy.ts:773-780 / openai-responses.ts:1239-1246 / google-genai.ts:906-921 / kimi.ts:641-655），且除 kimi 外都不带共享 undici Agent → 连接池不复用。
**修复**：各 provider 构造时 `new AuthClientLRU()` 并传入 `resolveAuthBackedClient`。

**K5. 工具 schema 每请求全量深拷贝 + 解引用重算**
`providers/kimi-schema.ts:10-24,126-133` + `providers/kimi.ts:211` — `normalizeKimiToolSchema` = `derefJsonSchema`（递归展开 $ref + 两次全树扫描）+ `cloneJsonValue` 深拷贝 + `recurseSchema` 类型推断，每工具每次 generate 执行。代码自身强调 schema 跨轮次字节稳定（prompt cache），缓存命中率本可 ~100%。
**修复**：以源 schema 对象身份为 key 的 `WeakMap<object, Record<string,unknown>>` memo 化。

### MINOR

- **k1** `openai-responses.ts:837`、`generate.ts:179`、`message.ts:196`、`chat-completions-stream.ts:72,81` — 流式工具参数 `+=` 累积；`startsWith/slice` 强制 flatten rope，大参数可能 O(n²)。>阈值改数组 push + join。
- **k2** `anthropic.ts:1121,1131` — native 路径 `onRequestSent` 双触发，native 成功时遥测把 1 个请求记成 2 个。
- **k3** `google-genai.ts:236-244` — `abortPromise` 在复用信号上累积永不触发的 listener（`{once:true}` 只在 abort 时自移除）[需确认调用方 signal 生命周期]。
- **k4** `anthropic.ts:332-337`（调用点 548）+ `anthropic-profile.ts:76-111` — `shouldPreserveUnsignedThinking`/`parseAnthropicModelVersion` 每消息重复跑正则。按 model memo 化。
- **k5** `anthropic.ts:1029-1035`、`google-genai.ts:501` — `mergeConsecutiveUserMessages` spread 复制累积 content，连续 k 个 user 轮 O(k²)；compaction 后 k 通常 ≤5，影响有限。

### NIT

- `anthropic.ts:788,826` — `toolUseBlockIndexes` Set 只写不读，死状态。
- `generate.ts:282,286` — `cancelStream` 两个空 catch，至少 debug。
- `capability-registry.ts:203-209` — `usesOpenAIResponsesDeveloperRole` 每消息线性扫 10 项 catalog。
- `native-bridge.ts:29-33`、`native-stream.ts:64-71` — ESM 下 `require` 未定义静默走 fallback，native 不可用真实原因被吞。
- `providers/astron.ts:44-52` — 构造时同步读 `~/.kimi-code/tui.toml`，工厂重复创建时重复读盘，可模块级缓存。

---

## packages/kaos（MAJOR 2 / MINOR 8 / NIT 6）

### MAJOR

**S1. glob 遍历每条目 stat() 判目录**
`src/local.ts:390-391,432-433` — `**` 分支对所有条目、非 `**` 分支对所有匹配条目各一次 stat syscall（stat 比 readdir 慢数倍）。ssh.ts:708/735 已用 `entry.attrs` 免额外 RTT，本地版反而多开销。
**修复**：`readdir(basePath, { withFileTypes: true })` 用 `Dirent.isDirectory()`，仅对需递归目录再 stat 取 ino 做环检测。

**S2. Read 工具每次调用全文件扫描 + 二次读取**
`src/local.ts:495-531`（`scanTextFile` 全文件字节扫描：行数+NUL+行尾+纯 JS 逐字节 UTF-8 校验 L816-867）+ agent-core read.ts:335,423 先扫后 range/tail 二次读。[需确认] 数百 MB 日志做 tail 时先付出 O(size) 纯 JS 扫描再读尾块，每次调用数秒级 CPU。
**修复**：scanTextFile 返回各行起始字节偏移供 range/tail seek；tail 只扫尾块。

### MINOR

- **s1** `local.ts:622`（internal.ts:167/178）— 逐行 decode 每次 `new TextDecoder`（含 fatal 构造）。模块级按 (encoding,fatal,ignoreBOM) 缓存单例。
- **s2** `local.ts:402` — glob 递归每层 `new Set([...visited,key])` 复制祖先链（100k 目录×均深 5 ≈ 50 万次复制）。改共享 Set + 递归前 add/返回后 delete（ssh.ts 已如此）。
- **s3** `local.ts:411` — glob `**` 分支每目录重编译同一正则。按 (pattern,caseSensitive) 缓存。
- **s4** `internal.ts:7-82,84-121` — errors='ignore' 走纯 JS 逐字节解码 + 每字符 `String.fromCodePoint`，比 TextDecoder 慢数倍。保留"合法 U+FFFD 不被删"语义改用 TextDecoder 后处理。
- **s5** `ssh.ts:834-849,852-905` — SSH mkdir 探测式 1-4 RTT/层级（exists→stat→mkdir→竞态重查），高延迟链路多级 mkdir -p 放大到数十 RTT。直接 mkdir 映射 EEXIST。
- **s6** `ssh.ts:1001-1006` — close() 的 5s setTimeout 在 'close' 先到时未 clearTimeout，CLI 退出最多延迟 5s 且重复 destroy()。
- **s7** `ssh.ts:253-256` — SSHProcess channel 'error' 仅 resolve(1)，错误对象被吞无日志，无法区分退出码 1 与传输故障。
- **s8** `internal.ts:252,275-279`（local.ts:89-90）— BufferedReadable 128KB 高水位下 wait()-then-read 死锁风险 [需确认，当前消费方未触发]。文档注明 128KB 上限或提供 drain 语义。

### NIT

- `ssh.ts:154-159,179` — mapSftpError 每次 spread 新对象（错误路径低频）。
- `local.ts:128-141` — Windows kill 每次 spawn 一个 taskkill，加幂等防重入。
- `local.ts:93-101, ssh.ts:240-257` — exit/error 监听器 settle 后未移除。
- `local.ts:759-769` — 每 exec spread 整个 process.env（envLayers 为空时已是零拷贝，可维持现状）。
- `ssh.ts:275-276` — channel 关闭时 signal() 可能同步抛错，与 Promise<void> 签名不符。
- `ssh.ts:505-567` — create 未设 keepaliveInterval 默认值，长空闲连接可能被 NAT 断开 [需确认]。

---

## packages/kap-server（MAJOR 8 / MINOR 13 / NIT 5）

### MAJOR

**P1. 消息历史每次请求全量重读重折叠**（同 Top T6）
`src/services/messages/messageHistory.ts:83,117,145,189` — 每条 `GET /messages`、`/messages/{id}`、`/snapshot`、`:undo` 都 flush wire journal + 全量读 append log + `createContextTranscriptReducer` 从零折叠全部历史 + blob 水合 + 全量投影，然后才分页 50 条。UI 轮询时放大。Top 3：`readTranscript`(189-199)、`loadMessages`(125-136)、`listMessages` 全量 reverse+findIndex(84-91)。
**修复**：按 journal 字节偏移增量折叠 + mtime/size 校验缓存。

**P2. 冷会话 transcript 每请求全量重建**
`src/routes/transcript.ts:246,394` + `src/services/transcript/transcriptService.ts:573` — 冷会话每次分页/`user-messages` 请求都 `readColdSnapshot`：读整个 `wire.jsonl`（`readFile` 全文件）+ reduce + group + fold，无缓存；翻页时每页重算全量。`readWireRecords` 全文件 `split`+逐行 parse（wireRecords.ts:17-35）。
**修复**：冷快照按 (sessionId, agentId, 文件 mtime/size/offset) 缓存；分页只需增量。

**P3. 每次 turn 结束全量重读 wire 文件做 heal**
`src/services/transcript/transcriptService.ts:506` — `healEndedTurns` 对每个 ended turn（250ms 防抖后）重读整个 wire.jsonl 全量重建 snapshot，只为取一个 ended turn 的 frames。长会话每轮付出 O(文件) 成本。触发链：`handleLiveOps`(437-439) → `scheduleTurnHeal`(443-458) → `healEndedTurns`(506-537)。
**修复**：只读末尾新增字节区间（用已持久化 offset），或仅重放该 turn 序号的记录。

**P4. live 搜索每请求全量 tokenize，预算检查在 tokenize 之后**
`src/search/searchService.ts:1543,1607,2142` — `searchLive` 每次 `collectLiveDocs`（全量快照 + 每 turn `Date.parse` + 每 frame trim）再对每个 doc 全量 `tokenize` + new Map；deadline 预算只在 `matchDocs`（1916 行）查，tokenize 阶段不受 500ms 预算约束。
**修复**：按 frameId 缓存已 tokenize 的 term 集合；deadline 检查下沉进 `matchLiveTerms` 循环。

**P5. 每请求同步 statSync**（同 Top T7）
`src/services/auth/tokenStore.ts:37` — 见 T7。注意 stat 结果本身有 mtime/ino 缓存（token 值），但 statSync 调用本身每请求同步执行。

**P6. 已激活 session 的 SessionState 永不回收**（同 Top T8）
`src/transport/ws/v1/sessionEventBroadcaster.ts:219,804` — 见 T8。`sessions.delete` 仅在创建失败路径 838 与 close() 785。

**P7. v2 会话列表每请求全量 drain + 全内存排序**
`src/routes/v2/sessions.ts:408,440` — `listRecent` 无 limit 拉全量，`filtered.toSorted()` 每请求 O(N log N)，page_size=50 也要排序整个集合。
**修复**：keyset 下推到 index（index 已有 `updatedAt desc, id desc` 排序）；非默认 sort 做 top-K 堆（复用 searchService RowTopK）。

**P8. shell 输出 outputTail 无界增长 + 每 chunk 全量复制 task**
`src/services/transcript/coreEventMap.ts:956` — `onShellOutput` 每 chunk `task.outputTail + text` 并 `{...task}` spread 复制；长构建（数十 MB stderr/stdout）内存常驻全量输出、时间 O(n²)。`this.tasks`(188) 只增不减 [需确认 transcript store 侧是否截断]。
**修复**：分片/环形缓冲（如每 64KB 一段）。

### MINOR

- **p1** `sessionEventBroadcaster.ts:1302-1303` — 每 global 事件新建 `Set(globalTargets)` + 遍历 `allTargets()`。维护合并集合。
- **p2** `sessionEventBroadcaster.ts:1293` — tail 满后 `shift()` O(n) 移位。环形缓冲。
- **p3** `sessionEventBroadcaster.ts:1098-1101` — 每 `agent.status.updated` 事件执行 `readLegacyStatus`（多次 DI get + 服务读）+ `JSON.stringify(snapshot)`，dedup 形同虚设。秒级节流或脏检查。
- **p4** `transport/ws/v1/fsWatchBridge.ts:227-252` — fs change 事件对每连接逐条 `ev.changes.filter(isUnderAny)`，O(conns×changes×paths)。按路径分桶。
- **p5** `routes/fs.ts:218,253` + `routes/terminals.ts:88` — 每 fs/terminal 请求 `resumeSessionById`（冷加载）+ handler 内二次 `getLiveSessionById`。路由层解析一次。
- **p6** `transport/ws/v1/sessionEventJournal.ts:215` — `flushOnce` 每批 `mkdir(recursive)`。提升到 open() 一次。
- **p7** `sessionEventJournal.ts:153-169` — `readSince` 每次从头流式扫整个 journal [需确认 getBufferedSince tail 覆盖率高，实际频率]。持久化 byte-offset 索引。
- **p8** `services/guiStore/guiStoreService.ts:36-40,78-101` — `getItem` 每次 readFile + 整文件 TOML parse，无缓存。内存缓存 + 写时失效。
- **p9** `routes/sessions.ts:462-488` — 未分页 `GET /sessions` 拉全量 + 逐 session `resolveSessionFacts`（注释承认"boot-time request storm"）。强制默认分页。
- **p10** `search/searchService.ts:1757` — read-only 进程每次搜索 3 次 stat 指纹。秒级 TTL 缓存。
- **p11** `wsConnectionV1.ts:572-605` — 慢客户端 backpressure 期间 outbound 无界累积（最多 100ms 强制 flush）。按字节数设上限，超限丢 volatile deltas 或断连。
- **p12** `coreBinding.ts:128-138` — `toolFrame` 查找每次 adopt 三层嵌套循环 O(frames)。projector 维护 toolCallId→frame 索引。
- **p13** `coreEventMap.ts:750-760` — `healTurnOps` 对每帧 `steps.find` + `frames.find` O(n²)。建 Map。

### NIT

- `sessionEventBroadcaster.ts:1153,1340` — 每事件 `{...event}` spread + `new Date().toISOString()`。会话内复用时间字符串。
- `transcriptService.ts:390` — ops journal 满 2000 后 shift()（摊销可忽略）。换 ring buffer。
- `searchService.ts:872,907,914,943`；`instanceRegistry.ts:137,169` — 多处 `catch {}`/`.catch(() => {})`（均为带注释 best-effort，建议 debug 日志）。
- `routes/fs.ts:206` — `(FS_ACTIONS).includes` 线性查找 13 元素。换 Set。
- `openapi/transforms.ts:362` — structuredClone 仅在 Swagger 构建期，非热路径（非问题）。

### 顺带（安全/正确性，未发现 CRITICAL）

- `routes/workspaceFs.ts:239-334` `fs::content` 可读任意绝对路径，注释明示"global bearer auth 是唯一门禁"——loopback 默认绑定 + 全局 auth 下可接受；公开绑定 + token 泄漏时是任意文件读取面。建议公开绑定时默认关闭该路由，或在文档/横幅强调。[需确认产品意图]
- 未发现硬编码密钥、SQL 注入、路径穿越（fs 路由均有 isWithin 约束）、越权。

---

## packages/klient（MAJOR 3 / MINOR 8 / NIT 3）

### MAJOR

**L1. IPC stream 转发无视 socket 背压**（同 Top T2）
`src/transports/ipc/host.ts:171-187`（send 定义于 71-73）— `send()` 忽略 `socket.write()` 返回值，`for await` 循环无 `await drain`。LLM 流式时消费端慢于引擎则写缓冲无界增长、引擎被超速拉取。client 端 `IpcChannel.stream`（channel.ts:139-191，注释自认 "buffers until the consumer drains"）同样隐式缓冲。
**修复**：`write()` 返回 false 时暂停，`await once(socket,'drain')` 后继续。

**L2. 每个事件/chunk 三重序列化**
`src/transports/memory/dispatcher.ts:36-39`（调用点 104/110/116/122/147/161/163/165/201/247）— 每个事件、每次调用参数/结果、每个 stream chunk 都过 `JSON.parse(JSON.stringify())`。生产 IPC 路径一个 chunk 实际被序列化 3 次：引擎产出 → `wireClone`（stringify+parse）→ `encodeFrame`（stringify）→ 客户端 parse。大 tool 结果（MB 级）每 chunk 多付一次完整深拷贝。
**修复**：IPC host 路径去掉 `wireClone`（encodeFrame 已保证可序列化）；in-memory 按需克隆或 `clone:false` 选项。

**L3. hubs Set 强引用持有每个 EventHub 直至 close()**
`src/core/klient.ts:99-107` — `hubs` Set 强引用每个 hub；`session()`/`agent()` 每次调用新建 hub。长驻进程反复创建 handle 时，已丢弃 handle 的 hub 永不被 GC（hub 无 listener 时释放了 channel 订阅，但对象被 Set 钉死）。
**修复**：不保留 hub 或在 listeners+subs 均空时移除；close() 时才遍历。

### MINOR

- **l1** `core/events/hub.ts:176-195`（keyOf 38-47）— `deliver()` 每事件遍历全部 registrations：`Object.entries` 新数组 + 每条目重新 keyOf 字符串拼接 + Set.has。预计算 `Map<key,string[]>`。
- **l2** `core/events/hub.ts:197-216` + `core/klient.ts:75-89` — 每投递事件与每 stream chunk zod `safeParse`（默认 validate=true），zod 解析重建对象。热路径可推荐 validate:false 或轻量 type 判别短路。
- **l3** `core/facade/session.ts:142-166` — `status()` 串行 N+1：2 次 listPending + 逐 agent 串行 `await` 探测。改 `Promise.all`。
- **l4** `transports/ipc/channel.ts:107-116` — 每次 RPC 调用创建 30s setTimeout（本地高频也如此）。快调用通道动态降级。
- **l5** `transports/ipc/channel.ts:275-277,281-283` — listen/unlisten 帧发送失败被 `.catch(() => {})` 吞掉，ready reject 时订阅从未建立且 onError 收不到通知。catch 中回调 onError。
- **l6** `transports/ipc/host.ts:157-197` — 每连接并发 stream/listen 无上限，异常客户端可无限开流。加 per-connection 上限。
- **l7** `transports/ipc/codec.ts:34-48` — `NdjsonDecoder.push` 每 data 事件 `buffer += chunk` + split。极端高频小帧场景改 indexOf 扫描。
- **l8** `transports/memory/dispatcher.ts:104,122` — `wireClone(event)` 在引擎 emitter 回调内执行，含 BigInt/循环引用会 throw 传播进引擎 emit 循环 [需确认引擎 subscribe 是否有 try/catch]。handler 外包 try/catch 转 onError。

### NIT

- `host.ts:215-216` — teardown 同时挂 'error' 与 'close' 双跑（幂等）。只挂 'close'。
- `transports/args.ts:10` — trimTrailingUndefined 每次 `[...args]`（≤3 元素，可忽略）。
- `core/facade/global.ts:320` — 清理失败 `.catch(() => {})`（best-effort，现有注释已表达意图）。

---

## 修复建议清单

按"高收益/低风险"排序。每条独立可执行、可验证。状态列可勾选。

### 第一批：热路径直接体感优化（建议优先）

| # | 目标 | 改动要点 | 验证方式 |
|---|---|---|---|
| 1 | `agent-core` MCP 监听器泄漏（T1/A1） | Agent 增加 dispose；会话回收已完成子代理时执行退订 | 长会话 spawn 100 子代理后对比 `McpConnectionManager.listeners.size` |
| 2 | `kosong` native fast-path 熔断（T3/K1） | catch 加 warn + 连续 N 次失败跳过 native | 断网/mock 429 验证只发 1 次 SDK 请求且有日志 |
| 3 | `kosong` native 流逐 token 回调（K2/K3） | ThreadsafeFunction 回调 + signal 传递 | 流式首字延迟对比；Esc 取消 <1s 生效 |
| 4 | `kap-server` auth statSync 每请求（T7/P5） | 秒级 TTL 缓存 stat | 高频 REST 压测事件循环阻塞消失 |
| 5 | `klient` IPC 背压（T2/L1） | write false 时 await drain | 慢消费端流式大结果内存平稳 |
| 6 | `klient` 三重序列化（L2） | IPC host 去 wireClone；in-memory 按需克隆 | 流式 chunk 吞吐/内存对比 |
| 7 | `kap-server` 消息历史增量折叠（T6/P1/P2） | journal 偏移增量折叠 + mtime 缓存 | 长会话翻页延迟对比 |
| 8 | `agent-core-v2` config 记忆化（T5/V1） | freshEffective 脏标记缓存 | 每步耗时对比（profiling） |
| 9 | `agent-core-v2` 工具选择 O(n²)（V2） | name→ToolInfo Map + list() 缓存 | 200 工具下每步耗时对比 |
| 10 | `agent-core-v2` toolsHash 缓存（V3） | 工具集版本 key 缓存 | 每请求 CPU 对比 |

### 第二批：内存/无界增长修复

| # | 目标 | 改动要点 | 验证方式 |
|---|---|---|---|
| 11 | `kap-server` broadcaster session state 回收（T8/P6） | session 关闭事件时 dispose state | 激活/关闭 100 session 后进程内存平稳 |
| 12 | `kap-server` shell outputTail 分片（P8） | 64KB 分片环形缓冲 | 100MB 输出内存有界 |
| 13 | `klient` hubs 强引用（L3） | 空 hub 从 Set 移除 | 反复创建 handle 后 heap 平稳 |
| 14 | `agent-core` session 索引缓存（A4） | 内存索引 Map + mtime 校验 | 数千 session list 延迟对比 |
| 15 | `agent-core` loopTools 脏标记缓存（A2） | 注册变更时重建 | 每步分配数对比 |
| 16 | `apps/kimi-code` transcriptEntries 裁剪（m2） | 超阈值裁剪 | 长会话内存对比 |
| 17 | `agent-core` records fsync 防抖（a3） | 10-50ms 合并窗口 | 慢盘高吞吐记录流积压对比 |

### 第三批：低风险快赢

| # | 目标 | 改动要点 | 验证方式 |
|---|---|---|---|
| 18 | `kaos` glob withFileTypes（S1） | Dirent.isDirectory 免 stat | 大目录搜索延迟对比 |
| 19 | `kap-server` v2 sessions keyset 下推（P7） | index 层分页 | 上千 session 分页对比 |
| 20 | `agent-core` session list 并发（A3） | Promise.all 上限 16-32 | 50 session list 延迟对比 |
| 21 | `apps/kimi-code` shell 输出 debounce（M3） | 50-100ms debounce + 增量 sanitize | 长输出命令 TUI 流畅度 |
| 22 | `apps/kimi-code` delta 增量解析（M1） | 仅 swarm 工具 parse + 增量 | 大参数流式 CPU 对比 |
| 23 | `kosong` kimi-schema WeakMap memo（K5） | WeakMap<object,...> 缓存 | 每请求 schema 处理耗时对比 |
| 24 | `kosong` AuthClientLRU 接线（K4） | 构造时传入 LRU | OAuth 场景连接池复用验证 |
| 25 | `kaos` TextDecoder 单例（s1） | 按 encoding 缓存 | 大文件逐行读耗时对比 |
| 26 | `agent-core` fsSearch 并行 DFS（A5） | 目录级 Promise.all + 剪枝 | 大仓库搜索延迟对比 |
| 27 | `kap-server` transcript heal 增量（P3） | 只读末尾字节区间 | 长会话每 turn 磁盘读对比 |
| 28 | `agent-core` resolveProviderConfig 缓存（A7） | model alias key 缓存 | 每步 provider 构造对比 |

### 待确认项（需先核实再改）

- `kaos` BufferedReadable 128KB wait-then-read 死锁（s8）——确认消费方模式后决定是否加 drain 语义
- `kap-server` `fs::content` 任意绝对路径读取（顺带项）——确认产品意图，公开绑定默认关闭
- `agent-core` `Session.agents` 保留策略（a1）——是否依赖 resume 语义
- `kosong` google-genai abortPromise listener 泄漏（k3）——确认调用方 signal 生命周期
- `agent-core-v2` explore profile 每 turn git 探测（v4）——确认上游是否有缓存
- `agent-core` grep CONTENT_LINE_RE O(n²) 回溯（NIT）——确认 content 模式列上限

---

## 方法与局限

- 7 个包由 7 个并行 explore 子代理精审（各读全部热路径源码），主 agent 抽查复核 6 处 MAJOR（MCP 泄漏、native 吞错、statSync、IPC 背压、config 重建、glob stat）**全部属实**，其余条目未逐条复核。
- 标注 `[需确认]` 的条目表示静态分析推断、依赖运行时行为或调用方约定，需实测确认。
- 行号基于审查时源码（commit `7bef953f4`），代码变动后可能偏移。
- 未做运行时 profile/基准测试；性能影响描述为定性估计。

# Rust-First 迁移（Codex 方向）— 现状与收口

> **本文档是"TS 壳 → 纯 Rust 核心"迁移的唯一权威。**
> 状态：**2026-08-13**——阶段 A–F 与 G 系列（G-0..G-7）**全部完成**，`@moonshot-ai/kimi-code` 已壳化（纯 Rust spawn），TS 仅剩 web 前端与分发壳。本文档描述**当前状态**，不再保留迁移过程流水账；历史批次与提交索引见 `retired/` 归档与 git 历史。
> 参考资产：`D:/kimi/参考目录/_extracted_codex_full/codex-main`（codex-rs，60+ crates）。

---

# 1. 方向定案（2026-08-06，不可回退）

> **最终只有浏览器前端是 TS。** 其余所有 TypeScript——CLI/TUI 宿主、server、SDK、协议、OAuth、ACP、LLM 抽象、i18n 数据、rust-loop 桥——全部迁入 Rust 或退役。

| 类别 | 保留 TS | 说明 |
|---|---|---|
| ✅ 保留（web 前端） | `kimi-web`(Vue3) / `kimi-inspect` / `vis/web` / `vis/server` | 浏览器 UI 与只读重放工具；`vis/server` 的 v1 投影算法拷贝（`v1-compat.ts`）仅供显示，不得扩展 |
| ✅ 保留（前端壳） | `vscode` / npm bin 包装（`kimi.mjs`） | VS Code 宿主 API 必须 JS；仅壳，逻辑走 Rust RPC |
| ❌ 迁 Rust | 全部宿主层 | 已全部落地（见 §3） |
| ❌ 退役 | 18 个 TS 包/模块 | 已全部 → `retired/`（见 §5） |

**明确不建** `sdk/typescript`——外部消费者使用 `kimi-sdk`(Rust) 或 HTTP 协议。i18n 文案：Rust 内置 en/zh（`kimi-tui/src/i18n.rs`）+ `i18n-shared`（web）。

**TS 冻结已随 G-7 解除**（冻结对象——`apps/kimi-code` 剩余 TS——已全部退役，FROZEN banner 保留在 `retired/` 归档中）。新能力一律写 Rust。

---

# 2. 完成状态（当前）

| 域 | 状态 |
|---|---|
| Rust 引擎（`packages/kimi-agent`） | ✅ 唯一引擎；`cargo test -p kimi-agent` 2173 全绿（2026-08-13 实测） |
| 阶段 A–F（框架/宿主协议/CLI/exec/TUI/SDK/ACP/OAuth/退役） | ✅ 全部完成（2026-08-03 → 08-11） |
| G-1 kimi-sdk 补齐 + 消费面切换 | ✅ 完成：事件广播/approval/tool handler、MCP 全局配置、workspace skills、config 小件、auth 扩展；vscode sdk-local 本地化 |
| G-2 Rust server（kimi-server + HTTP/WS v1 投影） | ✅ 完成：前端零改动直连，v1 wire 契约字段级对拍，MINOR 批复核 |
| G-3 CLI 消费面切 kimi-cli | ✅ 完成：parity 批次 6 + 入口差距评估（无代码差距） |
| G-4 TUI → kimi-tui | ✅ 完成：61 命令全命令面 + 交互对拍（117+ 测试） |
| G-5 LLM 面并入 | ✅ 完成：kosong 核心能力引擎覆盖，剩余数据项随退役 |
| G-6 退役收口 | ✅ 完成：11 包/模块 + pi-tui/migration-legacy → `retired/`；flake/lockfile/CI 同步 |
| G-7 web-only 壳化 | ✅ 完成（2026-08-11）：`kimi.mjs` 纯 Rust spawn；TS 入口与宿主测试全量退役；`kimi upgrade` Rust 化；vitest 收敛 |
| 测试基线 | ✅ cargo 全绿；vitest 1127 passed / 2 skipped / 0 failed（2026-08-13 实测） |

**收口复核（2026-08-13）**：flake.nix 同步（幽灵项清除 + kimi-shared/kimi-build 补录 + 检查脚本 optionalDependencies 盲区修复）；kimi-server 主路径注入 RecordStore（vis records 生产接线闭环，含子代理）；wire.gen.ts 与 Rust 源零漂移（gen:wire 幂等）；`.changeset/` 清理（private 包引用清零、ignore 补齐）；全仓退役包名扫描清零（活代码区 0 残留）；`kimi-native-tools/index.d.ts` 与导出 111/111 对拍。

---

# 3. 目标架构与 crate 现状

```
层1 协议层（纯类型，零 I/O）          kimi-protocol ✅
层2 引擎层（零 stdout，事件流输出）    packages/kimi-agent（未拆 kimi-core/kimi-state）
层3 宿主协议层（引擎包成 JSON-RPC）    kimi-server / kimi-server-transport / kimi-server-client ✅
层4 界面层（只消费协议）              kimi-cli ✅ / kimi-exec ✅ / kimi-tui ✅ / kimi-sdk ✅ / kimi-acp ✅ / kimi-oauth ✅
层5 前端/分发（保持 TS）              kimi-web(Vue) / vis / vscode / npm 薄壳 / i18n-shared
```

**主线（抄 codex）**：引擎零 I/O → server 把引擎包成协议（MessageProcessor + in_process 用同一套 JSON-RPC envelope）→ 所有界面只消费协议。

| crate | 状态 | 要点 |
|---|---|---|
| `kimi-protocol` | ✅ | JSON-RPC envelope + 92 方法常量 + wire_types；TS 绑定由 `gen-wire-contract.mjs` 生成（141 types，幂等） |
| `kimi-server` | ✅ | MessageProcessor + in_process + 11 processor（session/health/config/fs/git/approval/plugin/permission/cron/bg/task）；84 测试 |
| `kimi-server-transport` | ✅ | stdio serve + `kimi-server-serve` 二进制（事件扇出 stderr，无截断）+ WebSocket serve + HTTP/REST v1 投影 |
| `kimi-server-client` | ✅ | AppServerClient{InProcess, Remote, RemoteWs} 门面 + typed methods + 并发调用 |
| `kimi-cli` | ✅ | clap 分发：print/sessions/resume/config/doctor/health/export/chat/acp/completions/provider/login/logout/upgrade/migrate(退役提示)/server(弃用提示)/web/vis(退役提示)；全局 `--server`；真实 LLM 端到端打通 |
| `kimi-exec` | ✅ | -p/print + run_prompt 经 AppServerClient |
| `kimi-tui` | ✅ | ratatui 主循环 + kimi-ui 渲染原语 + EventSource；61 命令全命令面（G-4）；133 测试 |
| `kimi-sdk` | ✅ | Session 面全（50/50，含 `session/fs` 包装）+ Harness + catalog（models.dev 归一化）+ config/errors + /btw + auth；90 测试 |
| `kimi-acp` | ✅ | stdio 适配器 + set_mode/set_model + session/update 通知回放 + approval bridge |
| `kimi-oauth` | ✅ | device flow（authorize/poll/refresh）+ `kimi login`（自动开浏览器） |
| `kimi-config` | — | 定案不建独立 crate：catalog 内联 kimi-sdk、config TOML/env/合并于引擎、diagnostics 于 kimi-sdk `config.rs` |
| `utils/*` | 搁置 | 并入 kimi-native-tools/kimi-shared（path/cache/output_truncation/fuzzy/pty/token_count 均有 Rust 实现） |

---

# 4. 依赖图

```
kimi-protocol ← kimi-agent(引擎) ← kimi-server ← kimi-server-transport
      ↑            ↑                ↑              ↑
      └────────────┴────────────────┴── kimi-server-client
                                          ↑
    kimi-cli / kimi-exec / kimi-tui / kimi-sdk / kimi-acp / kimi-oauth ──┘
                                          ↑
                   kimi-web(Vue)/vis/vscode/npm 薄壳（TS）
```

---

# 5. 退役表（全部 → `retired/`，不回引）

| 原包/模块 | 处理 | 退役时间 |
|---|---|---|
| `apps/kimi-code` TUI（41k） | → kimi-tui（G-4） | 2026-08-09 |
| `apps/kimi-code` CLI/i18n/utils（18.4k） | → kimi-cli/kimi-tui；src/ 全量 → `retired/kimi-code-src/`（G-7 壳化） | 2026-08-11 |
| `kap-server`（16.2k） | → kimi-server | 2026-08-10 |
| `node-sdk`（16.2k） | → kimi-sdk | 2026-08-10 |
| `kosong`（11.1k） | 核心能力引擎覆盖 | 2026-08-10 |
| `oauth`（5.5k） | → kimi-oauth | 2026-08-10 |
| `acp-adapter`（5.4k） | → kimi-acp | 2026-08-10 |
| `protocol`（5.2k） | → kimi-protocol | 2026-08-10 |
| `kaos`（3.1k） | SSH 面无引擎需求，裁并 | 2026-08-10 |
| `transcript`（5k） | 本地化至 kimi-inspect | 2026-08-10 |
| `telemetry`（2k） | 本地化至宿主与 kimi-inspect | 2026-08-10 |
| `i18n`（18k） | 文案 → Rust 内置 en/zh + i18n-shared（last non-web TS package） | 2026-08-12 |
| `migration-legacy`（4.2k） | vscode 消费面本地化 | 2026-08-11 |
| `pi-tui`（13.2k） | 唯一消费者随 TS TUI 退役 | 2026-08-11 |
| `klient` | → Rust transport | 2026-08-05 |
| `agent-core` / `agent-core-v2` | → kimi-agent | 2026-08-03 |
| `minidb` / `kosong-native` | 引擎 SQLite 覆盖 | 2026-08 |
| `kimi-agent` 内 TS（rust-loop + runtime 兼容，7.4k） | Rust transport 覆盖，已删除 | 2026-08-10 |

**消费图**：退役包在全仓活代码区零引用（2026-08-13 扫描）；仅"本地化来源"注释与历史文档提及。

---

# 6. 已决策记录（有约束力，冲突时以本节省略为准）

## 引擎设计
- **setPermission 进程级**：Rust 引擎 permission 为 process-wide 设计（`permission/set_mode` 忽略 session_id）
- **`prompt_cache_key` Moonshot 专属**：仅官方端点发送，非 Moonshot 端点不发（真实 400 修复）
- **GitHub 工具族**：29 工具已移植；**Workflow 不补**（Rust background+Swarm 已覆盖）
- **kosong 不搬运**：三协议 + SSE + 重试 + prompt_cache_key + usage 引擎已独立覆盖
- **image 不迁 kimi-sdk**：压缩核心两处 Rust（native codec + engine media pipeline）**有意保留两套**——EXIF 对齐、alpha 均保留（PNG/WebP 走 RGBA）、滤波算法差异（Triangle vs Lanczos3）为有意取舍；共享核心下沉成本>收益，不做
- **summarizer 双通道**：`LlmCompactionDelegate` 经 `HostLlmProxy` 支持 host-proxy 会话；SDK `agent.nativeLlmProvider` opt-in 接线保留
- **compaction 同步语义**：引擎 compact 是同步 RPC，无 in-flight 可取消 → `session/cancel_compact` no-op
- **kimi-sdk `set_question_handler` 不实现**：引擎 AskUserQuestion 走"格式化内容 + stop_turn + 答案作为下一条消息"，无反向 RPC
- **kimi-sdk tool handler 仅 embedded 生效**：`HostCallbacks::execute_tool` 是进程内 trait 调用，stdio 传输无反向通道
- **`get_experimental_features` 保持 stub**：引擎 flags 无 RPC，不新增协议面
- **`kimi-config` 不建独立 crate**：避免重复实现（见 §3）
- **`task/cancel` 落 task 域**：bg/stop 保留给后台任务；未知 id 报错而非假装成功
- **MCP MRTR + CacheableResult**：`inputRequests` 按 schema map 解析；`roots/list` 自动应答 + 重试一次；sampling/elicitation 报描述性错误

## 工具教训
- **oxlint --fix 禁止全仓盲修**（2026-08-11 回退教训）：`consistent-type-imports` 误判 Vue SFC import、`no-useless-undefined` 误改 Promise 边界、数组→Set 误改——--fix 必须定向（单规则/单文件 + diff 审查）

## 测试策略
- **TS 用例重写而非平移**（用户定案，2026-08-05）——TS 测试随层退役，Rust 侧重写
- **vitest 归因修复边界**：引擎侧修复保留长期价值；TS 层仅做基线必要适配，不深挖过渡层边缘行为

## 迁移发现并修复的真实 bug（节选）
- `session/export` 丢失 base64 编码；`config/set` 不建父目录；`CronProcessor` 未 start；`session/fs` Glob pattern 丢失
- `prompt_cache_key` 无条件发送破坏非 Moonshot 端点（真实 400）
- EXIF 旋转：`image::load_from_memory` 不应用 EXIF，竖拍 JPEG 压缩后物理方向
- kimi-server-serve stderr 事件 512 行硬截断（修复为无限扇出）
- `config/get`/`config/set` 误用 validated loader（空 home 50001）
- homedir 顶替 work_dir（跨宿主 resume/workDir 过滤错位）
- metadata 不持久化（approval flags 跨 close/reopen 丢失）

## 引擎事件契约（宿主消费基准）
引擎事件为 `session.*` / `llm.*` 形状（session.turn.started/ended、llm.delta part、session.tool.started/settled、session.usage.updated、session.goal.updated、session.hook.result、session.task.*、session.compaction.started、session.approval.requested、session.shell.output）。SDK 原样转发 + sessionId/agentId 信封；SDK 合成事件仅 error。

## 测试环境隔离
- `KIMI_AGENT_HOME` 指向 scratch store（固定 session id 不跨运行泄漏 work_dir/metadata）
- `KIMI_CODE_HOME` 隔离（集成测试不得读真实用户配置）

---

# 7. 剩余项（不阻塞收口）

| 项 | 类型 | 说明 |
|---|---|---|
| 真实终端手动冒烟清单 | 人工验证 | 恢复会话/审批/@mention//plugins//tasks//goal next/Ctrl-G/图片粘贴 |
| 媒体富卡片 | 待定 | 终端图形协议，依赖终端支持，另议 |
| TUI 全交互流式在真实 LLM 下完整人工验证 | 人工验证 | 引擎侧已通 |
| ACP 兼容矩阵持续测试 | 依赖外部 | 依赖真实客户端 |
| swarm 子代理合成 replay | 待补 | 子代理 records 已接线；并入主会话 wire 视图需 XML 结果解析或 child-context 读 RPC |
| snapshot 进行中 turn 不可见 | 待定 | 跨连接 buffer 与 LocalTurnState 设计冲突 |
| 用户真实 config.toml 损坏（duplicate defaultModel） | 用户侧 | 建议用户删 camelCase 行（引擎已容忍混合键，2026-08-10） |

> ~~TUI 直连路径（RUN_TURN）无 session_id 不写 records~~ —— **已消除（2026-08-13）**：kimi-tui 经 `Harness::embedded()`（kimi-server）创建会话并走 `session/prompt`，kimi-server 主路径已注入 RecordStore（`state.rs::assemble`），TUI 会话与 CLI/server/web 一样写 records。

---

# 8. 验证基线（2026-08-13 实测）

| 验证 | 结果 |
|---|---|
| `cargo test --workspace --no-fail-fast` | **全量全绿（0 failed）**——含 kimi-agent 2118 + stdio 集成 55、kimi-server 84、kimi-tui 133、kimi-cli 67、kimi-sdk 90、kimi-server-client 4、kimi-server-transport 65 |
| `pnpm vitest run` | 1127 passed / 2 skipped / 0 failed（81 文件） |
| docs `npm run build`（docs/） | 通过（vitepress-plugin-llms 升级 1.13.4 修复 js-yaml 4 兼容） |
| `pnpm gen:wire` | 幂等（零 diff） |
| `node scripts/check-nix-workspace.mjs` | 通过（含幽灵项反向检查） |

> 注：Windows 上 cargo 测试曾受系统"智能应用控制"（WDAC）随机拦截 spawn（os error 4551，非代码问题）；用户关闭后全量通过。

---

# 9. 开放风险（跟踪）

1. **TUI 框架**：ratatui/crossterm（若需键盘增强/焦点事件，评估跟 codex 的 nornagon fork）
2. **协议契约**：TS 绑定由 gen-wire-contract.mjs 生成（141 types）；ts-rs 离线不可用暂不引入
3. **i18n**：Rust 内置 en/zh 已对齐关键文案；`i18n-shared` 服务 web 面
4. **McpServerSpecInput/SkillMetadataInput**：带引擎转换 impl 暂留 kimi-agent；后续以 free-fn 重构下沉

# PLAYBOOK — 上游改动翻译成 Bun

上游 `MoonshotAI/kimi-code` 用 pnpm + Node 构建，本 fork 用 Bun。**这不是排除上游功能的理由，是翻译的理由。** 每搬一条上游提交，先在这里找到对应形态，再动手。

规则：发现表中没有的形态，先补一行再改代码。改完的门槛见 `specs/upstream-sync-ledger/design.md` 的 Gate 一节。

## 工具链

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `pnpm-workspace.yaml` 增删成员 | 根 `package.json` → `workspaces.packages` | `bun install` |
| 同上，且影响 Nix 构建 | 同步 `flake.nix` 的 workspace 列表 | `bun run check:nix-workspace` |
| `pnpm-lock.yaml` 依赖变更 | 根 `package.json` → 改依赖后用 `bun install` 重生成 `bun.lock` | `bun install --frozen-lockfile` |
| `pnpm-lock.yaml` 里的 `catalog:` 引用 | 根 `package.json` → `workspaces.catalog` | `bun run check:catalog-versions` |
| `pnpm -r <script>` | `bun run --filter './packages/*' <script>` | 根 `package.json` scripts |
| `pnpm --filter <pkg> <script>` | `bun run --filter '<glob>' <script>` | 同上 |
| `pnpm <bin>` 一次性执行 | `bunx <bin>` | — |
| `.npmrc` 的 registry / hoist / node-linker | `bunfig.toml` 的 `[install]` 段 | `bun install` 成功 |
| `.nvmrc` / `engines.node` | 根 `package.json` → `packageManager: "bun@<ver>"` | `bun --version` |
| Node SEA 打包（`--experimental-sea-config`） | `bun build --compile`（`apps/kimi-code/scripts/native/build-bun.mjs`） | `bun run build` |
| GitHub Actions `actions/setup-node` | `oven-sh/setup-bun` | CI 不装 Node |

## 测试

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `vitest.config.ts` / `vitest.projects.ts` | 各包 `bunfig.toml` preload + `scripts/run-tests.mjs` | 包内测试跑通 |
| `import { describe, it, expect, vi } from 'vitest'` | `import { describe, it, expect, mock } from 'bun:test'` | `bun test --isolate <path>` |
| `vi.fn()` / `vi.spyOn()` | `mock()` / `spyOn()` | 同上 |
| `vi.useFakeTimers()` | `setSystemTime()` + `advanceTimersByTime` | 同上 |
| `test.each([...])` | `for (const c of cases) it(...)` | 同上 |
| `beforeAll/afterAll/beforeEach/afterEach` | 同名，`bun:test` 直接支持 | 同上 |
| `expect(x).toMatchSnapshot()` | 支持，但本 fork 优先写显式断言（见 `CONVENTIONS.md`） | 同上 |
| `globalSetup.ts`（vitest project 级） | 包级 `bunfig.toml` preload 或测试内 `beforeAll` | 同上 |
| `--reporter=verbose` | `bun test` 默认输出已逐条 | — |

## 运行时

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `node:fs` / `node:path` / `node:crypto` 等内置 | **保留**，Bun 全兼容 | `bun run check:boundaries` |
| 已有 Bun 等价 API，且该调用在实测热路径上（或门槛要求） | 改 `Bun.file()` / `Bun.spawn()` 等；否则保留上游的 `node:` 写法——`node:*` 是 Bun 自己的实现 | `tools/review/bun-native-baseline.txt` 只能收窄不能扩大 |
| `child_process.spawn` | `Bun.spawn()` / `Bun.spawnSync()` | 同上 |
| 按名字启动 `node` | 按名字启动 `bun`，或走 `process.execPath` | `tools/review/node-launch-baseline.txt` |
| 缺 `node:` 端点，需要降级实现 | 用 `Bun.*` 等价物；确实没有的登记进 `tools/review/bun-gap-baseline.txt` | `tools/review` 的 `bun-gap` 检查 |
| `process.env.NODE_ENV` 分支 | 保留，Bun 兼容 | — |
| `import.meta.dirname` | 支持 | — |

> `Bun.CryptoHasher` 只在 ≥100 KB 的实测热路径上替换 `createHash`（1.4x–3.1x）；`createHash` 默认保留，不算未完成的翻译。

## 构建与产物

| 上游形态 | 本地形态 | 怎么验 |
| --- | --- | --- |
| `tsc -b` / `tsup` | 各包 `bun run build`（`bun build`） | `bun run build:packages` |
| `api-extractor` 产出 `.d.ts` | 保留，是发布产物的一部分 | 见包内 `build` 脚本 |
| `dist-web` web 产物（每次同步哈希名都变） | 对齐上游预构建产物，整目录替换，不叠加 | `apps/kimi-code/scripts/check-web-assets.mjs` |
| `flake.nix` 的 Node 构建路径 | 保留，Nix 路径仍需要 Node | `bun run check:nix-workspace` |

## 明确不搬的文件本体

这些文件在上游存在，本地刻意没有，`tools/review/upstream-drift-allow.txt` 已登记：

- `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.npmrc`、`.nvmrc`
- 所有 `vitest.config.ts` / `vitest.projects.ts`
- `vitest.config.ts` 的 `globalSetup.ts`（`packages/kap-server/test/globalSetup.ts`）
- Node SEA 脚本（`02-sea-blob.mjs`、`03-inject.mjs`、`build.mjs`）
- `.husky/`（改用 `simple-git-hooks`）

**注意**：`upstream-drift` 只检查"上游有、本地整个文件都没有"。它**不检查同一文件内的内容缺口**。后者由 `.upstream/ledger.tsv` 覆盖，两者互补，缺一不可。

## 门槛基线说明

- `tools/review/silent-catch-baseline.txt` 里 `packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts` 的配额是 8（原 5）。`4306e8396b` 提高了配额但提交说明未写明：多出的 3 处 `catch {}` 来自 `e1f0d5c5c8` 的会话 feed 推送路径（`turns.failed`、`turns` 分页快照、单条 conversation 事件），语义是单个 WebSocket 目标发送失败只放弃该次推送、不中断广播器，可接受。这不是历史欠账；后续重构该文件时应重新评估并收窄配额。
- `tools/review/silent-catch-baseline.txt` 里 `apps/kimi-code/src/utils/clipboard/clipboard-text.ts` 的配额是 2（原 1）。`Bun.spawn` 改写带入的第二处 `catch {}` 是 `spawnClipboardProcess` 的 `kill` 适配层：`Bun` 的 `Subprocess.kill` 在写入进程已经退出时会抛错，而超时路径要的正是"进程不再占用剪贴板选择区"，该错误既无补救动作也不影响随后 `claim()` 返回 `false`，与 `clipboard-common.ts` 已登记的同类适配层语义相同；另一处是原生剪贴板 `setText` 失败后继续走平台命令回退，错误本身就是控制流。两处都必须忽略，不是历史欠账；若以后给适配层接入诊断日志，应同步收窄配额。

## 已知差异（每次都要记住）

| 差异 | 影响 | 处置 |
| --- | --- | --- |
| 本地独自 2276 条提交，远超上游 61 条未合入 | 上游改动落在本地改过的文件上时，不能照搬 | 先读本地实现，判断等价与否，再决定改哪里 |
| 本地多 `apps/kimi-inspect` | 上游 #4514 删除了它 | 已决定跟着删除（B12） |
| 本地多 `.github/workflows/codeql.yml`、`release-native.yml`；少 `canary-release.yml` | 上游 CI 改动不能整文件搬 | 只提取"检查什么"，落到本地 workflow 结构里 |
| 本 fork 有完整 i18n（中英双语），上游没有 | 任何新增用户可见字符串都要走 `t()` | 触发 i18n 三项检查 |
| `packages/agent-core-v2`、`kap-server`、`transcript` 是零注释区 | 照搬上游代码会带进注释，直接卡 gate | 搬完删注释，`bun run check:no-comments` |
| #4538 的 loop/requester/media 分层重构仍保留本仓结构；本批已落地 revision 持久化 | 不能把本批宣称为 #4538 全量分层迁移；schema 继续由本仓 pending reminder 落地 | `toolSelectOps` 承载 initial/current/changes，公告携带 disclosure，unsupported history 转为 runtime reminder；剩余分层差异记入 `d37f9ccc` 台账行 |
| 本 fork 有原生 Operation Log（jj 风格 op log + 隔离 Git plumbing），上游没有 | 不能把上游 stash、checkpoint 或文件快照恢复当成等价能力；恢复覆盖文件树与 `HEAD`/refs，不覆盖会话 wire | 由 `features/operationLog` 与 SDK/Klient operation 协议承载；`/undo` 保持 turn 语义，flag 默认关闭；这是本地新增能力，不在 `ledger.tsv` 伪造上游记录 |
| 2.5.3 发布线 #4792 的 transcript 修复未进入 `upstream/main`；#4811 的主线后像已被 #4663 删除旧服务 | 不能用 #4811 后像覆盖本仓 `transcriptService`；本仓继续保留 live overlay、undo 与 Operation Log 投影 | 以标签提交 `1b5359d0e0` 的原始 diff 移植 `turnShapeDiverges`、`healTurn` 与 reset；`packages/kap-server/test/services/transcript.test.ts` 133 用例通过 |
| 2.6.0–2.6.2 发布线的 7 个提交只存在于 release 分支，不在 `upstream/main`，`ledger.tsv` 无行 | 不能用台账 `--refresh`/`--set` 追踪它们；只能从 tag `@moonshot-ai/kimi-code@2.6.2` 的原始 diff 移植 | #4905 媒体上传校验（f6a5ebe62c）与 #4922 Swarm 任务事件（c13c86f900）已落地；#4885 判定 equivalent（本仓重放路径无 per-event structuredClone，见 `replayImmer`/`replayMutableStates` 分支）；#4888 的原 equivalent 判定已随 Web 对齐重新核对（仍不引入 `journal.ts`；loop 状态保留 `replayMutableStates`，恢复的 `kap.conversation` participant 使用 #4893 的独立可变暂存、恢复成功后一次冻结发布。失败不发布部分历史，带可变 participant 的初次恢复也排队实时事件；见 `specs/cyclops-jessica-cruz-signal`）；#4907 的压缩锚定半已落地（0406c614a0：historyRequestTokens/usageAnchored + HistoryTokenProfile 进入 fullCompactionService 与 compactionGeneration，tokenCountWithPending 取 max），其 tokenCounting 测量半判定 equivalent（本仓 `measured` 以 `context.get()` 的原始消息对象做身份匹配，projection 不进入 `measured`，上游因投影后的工具结果失配的路径在本仓不存在）；#4875 已落地（registry `search_url`/`feedback_url`、engine `FeedbackService` 与 engine 内附件打包/上传、SDK/TUI 接线；fork 保留 `codebaseTruncated`、流式双哈希与上传前大小护栏）；#4876 判定 partial/blocked：引擎侧已落地（去掉 `/feedback` 纯文本选项、availability 返回 `FeedbackSessionPreview`、`sessionExport.preview`、global-log 空会话回退、git 扫描忽略目录过滤），但用户可见能力未完成——TUI 尚未消费 `availability.session`，会话文件披露 UI 为 blocked：依赖上游 #4751（b64a016b16）把 `ChoicePickerComponent` 拆成 head/body/foot 并提供 `PreviewChoicePickerComponent`，本仓仍是单体 `render`，不得用自造 UI 顶替；`request_id` 元数据同为 blocked：依赖 requestObservation/requestAttribution/turnProjection 分层（本仓 loop 仍是 machine 架构，无 `ISessionRequestAttributionService` 与 TurnEnded.requestId），因此无来源的 `ExportSessionPreview.requestId` 已删除，待该分层落地后再随 #4876 补回 |
| fork 的 `isSensitivePath` 对路径段与文件名做大小写折叠后再匹配敏感名单 | 上游同名函数大小写敏感；本仓对 `.SSH/`、`ID_RSA`、`SECRET.PEM` 等变体同样排除 | 有意偏离（比上游更保守的敏感文件排除），保留；除此之外扫描规则与上游一致，改动该函数时不得去掉折叠 |
| 上游 2.7 的 `loop` 在 steer 时结束当前 turn（`finishSteeredStep` → `turn.finish`）；本仓要求 steer 消息在同一 turn 内送达模型并继续下一步 | prompt 队列、TUI 的 in-turn steer、turn/step 事件编号和 undo 锚点都依赖同一 turn；换成跨 turn 会多出 `turn.started` 并使 steered prompt 变成新 turn | 保留 fork 语义：`LoopActor` 把 steered 消息放进 `turn.pending`，step 以 `continue` 结束，`afterStepFinished` 先 `turn.append` 再 `step.start`；`turnProjection` 对已被 steer 的旧 step gate 做 stale 丢弃，避免迟到的 gate 失败污染后续 turn；`core/hooks.test.ts` 的 `sendNow` 用例按 in-turn 交付改写。探针 `test/agent/prompt/promptService.test.ts` 31 通过 |
| 上游 2.7 的 `add-dir` `persist:true` 只写 workspace registry，`local.toml` 变成只读遗留输入；本仓文档契约（en/zh `server-api-service.md`）写明追加到 `local.toml` | 只写 registry 会让文档与磁盘不一致，外部工具也看不到新增目录；只写 `local.toml` 则丢失上游的 registry 复用 | 双写：`appendAdditionalDir` 镜像 `local.toml`，同时保留 registry 更新与 reload；managed 工作区本来不读该文件，写入无副作用。探针 `workspaceDirsService.test.ts` 21 通过 |
| 上游 2.7 的 ACP terminal overlay 只转发输出，不告知客户端 4 MiB 缓冲截断；fork 在截断/无标记回退时向模型写一次不可恢复提示 | 客户端缓冲滚掉头部后，模型会把缺失前缀当成完整输出 | 保留 fork 的 `TRUNCATION_NOTICE` 与一次性 `truncatedNotified`，并把可注入 `AcpTerminalTimers` 带回 overlay，探针 `acp-terminal.test.ts` 6 通过 |
| 上游 2.7 的 `step.started` 在 step.starting 钩子（含自动压缩阻塞）之前记录；fork 的 UI 事件把压缩完成放在 step.started 之前 | `turn.step.started` 会先于 `compaction.blocked` 到达，但 LLM 请求仍会等待压缩完成；UI 需要靠 `compaction.blocked` 状态而不是 step 事件判断阻塞 | 请求仍按 fork 语义阻塞；事件顺序断言改锚到 `turn.step.completed`（压缩完成必须早于本步完成），不改变阻塞行为 |
| 上游 2.7 的 turn 请求使用 core loop 的 durable messages；fork 的 context memory 是 loop journal 的投影（含 reminder 注入与压缩后的形状） | 只在 running turn 内写 context 的 reminder 进不了 loop 请求；compaction 的 summary 请求又只读 context，pending reminder 会被漏掉；重建的 in-flight turn 还会把压缩前已注入的 reminder 再带一次，与 rearm 重注入重复 | 请求历史以 loop messages 为准，journal 折叠把同一条消息写回 context；compaction 读取历史前先 `flushReminders()`，并让 provider 用 `rearmOnCompaction` 标记压缩后会重注入的 injection，重建 shape 时排除它们；`fullCompaction`（含 goal reminder 三例）与 `context`/`forkParity` 覆盖 |
| 上游 2.7 的 turn 请求直接使用 loop profile 的 tools 快照；fork 在 turn 开始时快照 activeToolNames/disallowedTools 作为本 turn 的 tool policy | mid-turn 更新若立即生效会改变当前 turn 的后续步骤 | toolPolicy 与 tool-call guard 在 `TurnStarted` 快照、`TurnEnded` 清空，mid-turn 更新只影响下一 turn；`baselineTools` 在 loop 初始化时按 activeToolNames 过滤（`undefined` 不过滤） |
| 上游 2.7 的 `notify` 一律排队到下一个 turn；fork 的 `turnScoped` 通知默认在当 turn 内消费 | repeat breaker 的 handoff 需要在同一 turn 追加第 13 步；stop hook 的 continuation 需要新 turn | 只有 `bypassMaxSteps: true` 的通知 adopt 进当前 turn 并由 `finalizeStep` 转成 continue（并只 bypass 该步）；其余通知保持 mailbox 语义。task/tower 显式 `turnScoped:false` |
| 上游 2.7 的 `afterExecute` 钩子只对 `prepared.kind === 'execute'` 调用；fork 的所有 outcome（preflight-rejected/synthetic/vetoed）都进入 dedupe | preflight 拒绝完全绕过 repeat breaker，计数、提醒与 stopTurn 全部失效 | `forkHook.afterExecute` 对所有 outcome 调用 `onDidExecuteTool`；`tool.ended` 事件携带 `stopTurn/stopTurnReason`，projection 在无 prepared 结果时回退到事件结果 |
| 上游 2.7 的 projection 会在 turn 结束时重建 context message 对象 | `historySafeToCompact` 的对象身份比较会把后台压缩误判为“前缀已变”而取消 | 改为按 role/content/toolCalls/tools/origin 的结构比较；后台 auto compaction 可跨 turn 完成并归属起始 turn |
| 上游 2.7 的 token 测量把 resolved request 的 messages 当作 measured 长度；其中可能含被 shapeHistory 隐藏的注入 | `token_counting.measured.length` 多算隐藏消息，snapshot/telemetry 偏移 | 用 provider-visible 的 `input.messages`（shape 后）测量；未命中时保持原 anchor 语义 |
| 2.7.0 loop 运行时已切换到上游 `loop/core`，machine loop 退役 | fork 的 in-turn steer、turnScoped notify、bypassMaxSteps、afterExecute、context memory 请求历史等契约必须继续由适配层提供 | 以 backup tag `wip-2.7-loop-runtime-adoption-6e7adb5932` 为准合入；`coreLoopService.test.ts` 与全量 agent-core-v2 套件全绿后才算完成；`test/lint/unreachable-modules.txt` 的 upstream-dead 条目随迁移清理 |
| 上游 2.7 的 core loop 按模型顺序一次只启动一个 tool call；fork 旧 machine loop 并行启动 sibling | 依赖 sibling 并行/abort 的用例必须按顺序语义改写；`abortTool` 只影响当前运行中的 call | 接受上游顺序执行（2026-11-24）；`toolAdapter.test.ts` 的 sibling 用例与 `core/record.test.ts` 的 detached 用例改为顺序启动；并行需求另行设计 |

| 上游 #4965 删除 KAP 的预测提示、会话子代理、goal 编辑与 session abort 等“废弃”接口，并把 prompts abort 收窄为 abort-only；fork 的 klient/SDK 与桌面/TUI 仍在调用这些接口 | 照搬删除会让 `predictNextPrompt`、goal 编辑、子代理列表与会话 abort 立即失效；fork 的 `cancel` 动作已用自有 `cancelSessionRequestSchema` 提供等价能力 | 有意偏离：保留这些 KAP 接口与 schema，abort→cancel 以 fork 的 `cancel` 动作为准；本行随台账 #4965 记为 not-applicable，删除需先移除对应客户端能力 |

| 上游 #5337 用 `loopLifecycleEvents` 能力标志把 `turn.ended.loopEnd`（drained/idle）接到 TUI：phase 置 waiting、`finalizeLoopEnd` 出队并写通知；fork 从未载入该能力标志，也没有 `finalizeLoopEnd`/`resumeLoopEnd` | 照搬会让 TUI 在 loop 排水时提前把 phase 变成 waiting，与 fork 的 queuedMessageDispatchPending/turnScoped notify 语义冲突 | 有意偏离：引擎侧保留 loopEnd 计算与 wire 字段（core loop-actor 的 postTurnLoopEnd/settleLoopEnd + closeUnfinished(followedByWork) 已落地，record 测试覆盖 idle），TUI 继续按既有 turn 语义收尾、忽略 loopEnd；要接 UI 需先设计 fork 自己的能力标志与 queued 出队时序 |
| 上游 2.8 的 Workspace → Project 重命名（#5206） | 2026-11-26 起跟随上游：文件和符号统一用 Project，避免后续同步时同一概念两套名字；fork 独有功能保留 | 执行 #5206 的机械改名（106 文件移动、443 处 import、104 个顶层声明），按上游的“保留项”清单保留 DI/state/event/配置/持久化字符串与 workspaceId 等成员名；fork 功能在改名后重新接回 |

## 每条的落地顺序

1. `git show <sha>` 读上游改动
2. 在本表找到对应形态
3. 读本地同类实现，判断是"原样搬""需翻译"还是"已经等价"
4. 改代码，同时补测试（测试用 `bun:test`）
5. 跑 `design.md` 的 Gate
6. `bun scripts/upstream-ledger.mjs --probe <sha> <probe>` 记探针，再 `--verify` 推进判定
7. 提交并推送；本表若有新形态，先补行

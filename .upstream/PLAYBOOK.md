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
| 上游重新带回 `02-sea-blob.mjs` / `03-inject.mjs` / `build.mjs` / `postject` | 删除这三个脚本与 `postject` 依赖；原生目录整体以 fork 的 Bun 版本为准 | `bun run build:native:bun` |
| `tsdown.native.config.ts` 的 `neverBundle` 可选原生依赖 | `bun build --compile` 不继承该外部化，须在 `build-bun.mjs` 补 `--external <pkg>`；2.7.0 起 `canvas`（经 d3）与 `cpu-features`（经 ssh2）会进图，缺参数则报 `Could not resolve: ../build/Release/canvas.node` | 编译成功 + 产物 `--version` |
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
| 已有 Bun 等价 API 却仍用 `node:` | 改 `Bun.file()` / `Bun.write()` / `Bun.spawn()` 等 | `tools/review/bun-native-baseline.txt` 只能收窄不能扩大 |
| `child_process.spawn` | `Bun.spawn()` / `Bun.spawnSync()` | 同上 |
| 按名字启动 `node` | 按名字启动 `bun`，或走 `process.execPath` | `tools/review/node-launch-baseline.txt` |
| 缺 `node:` 端点，需要降级实现 | 用 `Bun.*` 等价物；确实没有的登记进 `tools/review/bun-gap-baseline.txt` | `tools/review` 的 `bun-gap` 检查 |
| `process.env.NODE_ENV` 分支 | 保留，Bun 兼容 | — |
| `import.meta.dirname` | 支持 | — |

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
| fork 普通任务增加非终态结束审计，上游没有该完成门禁 | “只承诺继续”“无依据上下文耗尽”“下一轮再做”不能被当作已完成；这是有限文本识别，不保证涵盖所有自然语言变体 | 复用 `onDidFinishStep` 与同回合 `loop.notify`，不新增 requester 或纠偏次数预算；仅对已有执行范围纠偏，跳过已有 Goal，保留取消、stopTurn、必要审批和真实 maxStepsPerTurn；本地能力不伪造上游台账行 |
| DeepSeek 保留用户指定的内部压力测试角色与无限工作投入设定 | 不因猜测配额而缩减必要阅读、实现或验证；不宣称真实厂商身份、物理上下文无限或跳过权限 | 单一 `curated/deepseek.md` 随目标模型重新渲染系统提示；用户明确限制和运行时实际报告仍有效，切出 DeepSeek 后移除专属段落 |
| 本 fork 有原生 Operation Log（jj 风格 op log + 隔离 Git plumbing），上游没有 | 不能把上游 stash、checkpoint 或文件快照恢复当成等价能力；恢复覆盖文件树与 `HEAD`/refs，不覆盖会话 wire | 由 `features/operationLog` 与 SDK/Klient operation 协议承载；`/undo` 保持 turn 语义，flag 默认关闭；这是本地新增能力，不在 `ledger.tsv` 伪造上游记录 |
| 2.5.3 发布线 #4792 的 transcript 修复未进入 `upstream/main`；#4811 的主线后像已被 #4663 删除旧服务 | 不能用 #4811 后像覆盖本仓 `transcriptService`；本仓继续保留 live overlay、undo 与 Operation Log 投影 | 以标签提交 `1b5359d0e0` 的原始 diff 移植 `turnShapeDiverges`、`healTurn` 与 reset；`packages/kap-server/test/services/transcript.test.ts` 133 用例通过 |
| 2.6.0–2.6.2 发布线的 7 个提交只存在于 release 分支，不在 `upstream/main`，`ledger.tsv` 无行 | 不能用台账 `--refresh`/`--set` 追踪它们；只能从 tag `@moonshot-ai/kimi-code@2.6.2` 的原始 diff 移植 | #4905 媒体上传校验（f6a5ebe62c）与 #4922 Swarm 任务事件（c13c86f900）已落地；#4885 判定 equivalent（本仓重放路径无 per-event structuredClone，见 `replayImmer`/`replayMutableStates` 分支）；#4888 的原 equivalent 判定已随 Web 对齐重新核对（仍不引入 `journal.ts`；loop 状态保留 `replayMutableStates`，恢复的 `kap.conversation` participant 使用 #4893 的独立可变暂存、恢复成功后一次冻结发布。失败不发布部分历史，带可变 participant 的初次恢复也排队实时事件；见 `specs/cyclops-jessica-cruz-signal`）；#4907 的压缩锚定半已落地（0406c614a0：historyRequestTokens/usageAnchored + HistoryTokenProfile 进入 fullCompactionService 与 compactionGeneration，tokenCountWithPending 取 max），其 tokenCounting 测量半判定 equivalent（本仓 `measured` 以 `context.get()` 的原始消息对象做身份匹配，projection 不进入 `measured`，上游因投影后的工具结果失配的路径在本仓不存在）；#4875 已落地（registry `search_url`/`feedback_url`、engine `FeedbackService` 与 engine 内附件打包/上传、SDK/TUI 接线；fork 保留 `codebaseTruncated`、流式双哈希与上传前大小护栏）；#4876 的剩余能力已补齐：移植 #4751 的 head/body/foot 与 `PreviewChoicePickerComponent` 后，TUI 消费 `availability.session`，披露真实文件、全局日志和元数据，支持分页及终端文件链接，远程会话保持 logs-only，导出排除 file-history；`request_id` 接通上游 `RequestMetadataTracker`、`ISessionRequestAttributionService` 与持久化 `TurnEnded.requestId`，preview 使用主 agent 的最后有效服务端 ID，feedback 自动填入并保留显式 info 优先级。#4830 的 tracker/service 挂在本仓既有 machine/requester 扩展点，不另建请求链；这不等于宣称整个上游 loop/requestObservation 分层已迁移 |
| fork 的 `isSensitivePath` 对路径段与文件名做大小写折叠后再匹配敏感名单 | 上游同名函数大小写敏感；本仓对 `.SSH/`、`ID_RSA`、`SECRET.PEM` 等变体同样排除 | 有意偏离（比上游更保守的敏感文件排除），保留；除此之外扫描规则与上游一致，改动该函数时不得去掉折叠 |
| 2.6.3 首批 5 个请求正确性提交只存在于 release tag `b0de2fbd2de04d87689225aafd3912e5d193b62d`，不在本地 `upstream/main`，`ledger.tsv` 无行 | `scripts/upstream-ledger.mjs` 只追踪 `upstream/main`，不能为 tag-only commit 伪造台账行 | #4971 `a29c2d0379e6ffe95b2bdeafe143bdf149815dac` equivalent（`toolSelectService.test.ts` 验证 provider payload）；#4990 `cd83fdd96b65e2c96544b028111fe60c4869181c` equivalent（`fullCompaction.test.ts` 四请求和冷启动回放）；#4977 `1101ea7d60377c606094bf05497cb9bd0dc2242f` ported（`empty-response.test.ts`、`turn.test.ts`、`modelRequester.test.ts`）；#5006 `1311098df26e08a5a4a5e86566646ca851b11e42` ported（同组测试加 `fast-upstream.test.ts` 干净 EOF）；#5017 `c15cc1c56155bdc20b7f84d41e530d8ceb870d7f` ported（`usage.test.ts`、`trait.test.ts`、`fast-upstream.test.ts`）；本批 probe 与接受标准见 `specs/quasar-jade-hourman/tasks.md`，不调用 `--refresh`/`--set` |
| 2.6.3 第二批恢复兼容性同样来自 release tag，`ledger.tsv` 无行 | 沿用 release-only 证据记录，不伪造主线台账；保留 fork 的 profile/权限/工作区结构 | #4982 `9d7f9af9fba7d1282873a31ec8486f9ea956c591` ported：`packages/node-sdk/test/sdk-rpc-client-v2.test.ts` 的 removed implicit default 用例验证冷/热恢复、切模型后请求和显式无效模型拒绝；`apps/kimi-code/test/cli/v2-run-print.test.ts` 验证会话模型认证。#4987 `b2716e26c5de835d2f8eb8d5122e6448c9d84805` equivalent：其 tree 与父提交 `a29c2d0379e6ffe95b2bdeafe143bdf149815dac` 同为 `853d7e74f26176fc29c657b33f0b551ea21df0da`，没有额外 diff。#4980 `c4f6746aeaf57b889226ad02cf70b692fb419436` ported：`sessionIndex.test.ts`、`sessionIndexMirror.test.ts` 验证不匹配版本保留 checkpoint/collection、停止自动重建、30 秒缓存复用及到期刷新；本仓额外封住 mirror、工作区 primary 刷新、显式 reconcile 和 ready 后切换 schema 的入口。#4991 `6ba822ed21a79c46189669357094fe20a241aa4a` ported：`config.test.ts`、`permissionRules.test.ts`、SDK/CLI/kap-server 配置回归验证默认值/最后有效值、坏文件写回阻断、显式环境拒绝和完整诊断；用户提示保持中英双语，项目权限规则校验不变。尚不代表完整 2.6.3 发布对齐完成。 |
| 2.6.3 剩余行为补丁来自同一 release tag，`ledger.tsv` 无行 | 按本仓 machine 架构移植，等价项保留既有用户能力并给出可执行证明；不把已完成行为当作版本发布完成 | #4989 `9c75e5aa97e6720add1f7e5833d5b31d99bb25c4` equivalent：恢复终态任务直接追加上下文，失联任务保留 `task_resume_termination` 汇总提醒，不移植上游 prompt-only turn carrier；`idle-notification-repro.test.ts` 的 RESUME 用例和 SDK `session-prompt-events.test.ts` 的 restores and forks 用例验证恢复/分叉零模型请求、下一条用户请求带任务信息。#4992 `0617b20ce76cd4aaf6be8c8b6093b424833e2746` ported：真实提交事件携带 origin，Tower 仅接受用户、插件命令、user-slash 技能中断唤醒；loop 与 Tower 来源矩阵回归。#4994 `20169174c815ada19093bc687b1433ef8b52f8f9` equivalent：本地前台 Shell 直接执行 Bash，仅发 shell.* 事件、不走通用 toolExecutor；`shellCommand.test.ts` 验证无 tool.* 事件和模型请求，因此不新增无消费者的 origin 协议。#4995 `f6996a9292cd970491247d00783f18e92991f417` ported：Stop 在完成事件后串行执行，携带最终步骤事实；本地使用现有 untracked submit 承载一次续跑，避免本仓通知队列交接时消费掉续跑消息；integration 回归涵盖动态 hooks、完成状态与续跑限制。#4993 `1590a95bb0590f7bf1c6d08820da2c4900e8bc5f` ported：settled 返回最终结果，runAgentTurn 等后台子任务和通知轮次；取消用既有 suppressTerminalNotification/stop 清理，保留 helper 来源及部分输出；runAgentTurn/loop 回归。#4999 `9bf2891bc629bd0fa6b826b7c10762e4a45765be` ported：Windows WebBridge 确认、先下载后停止、备份、替换启动及失败恢复；原补丁 9 场景加本地 24 场景通过，保留本地 marketplace/fetch seam。 |
| `apps/vscode` 的 katex 声明为 `^0.18.2`，`apps/desktop` 与 `packages/app-markdown` 沿用上游 `^0.17.0` | `sherif` 报 multiple-dependency-versions；上游 2.7.0 的忽略清单里没有 katex（上游这两处版本一致） | 根 `sherif` 脚本改为上游 2.7.0 的忽略清单（`vite`/`fuse.js`/`jsdom`/`tsdown`/`typescript`/`diff`/`@vitejs/plugin-vue`）并追加 `-i katex`；vscode 的高版本是本地既有决定（1d30d38ad6），不降级以免回退其修复 |
| 2.7.0 的整文件重写与去注释（#5019）连带清掉了 fork 的 `t()`：三棵 locale 树（`apps/kimi-code/src/i18n`、`apps/vis/web/src/i18n`、`apps/vscode/webview-ui/src/i18n`）被整目录删除，CLI 的 2910 处 `t()` 归零，vis/web 与 vscode webview 同样归零 | 用户可见文案全部回退成英文硬编码；`check:locale-keys`/`placeholders` 因文件缺失失败，`check:t-coverage` 无法加载 vis/web 语言包 | 每轮同步先 `git checkout <基> -- <三棵 locale 树>` 恢复语言包，再按 HEAD 的 `t()` 位置回灌调用点（hunk 内 key 与英文值精确匹配，跳过模板三元与比较位），剩余新增文案补 en+zh；`check:no-hardcoded-prose` 的 ledger 只能收窄 |

2.6.3 第二批验证（2026-11-19，Bun 1.4.4）：各拥有包依次运行 `bun run test --per-file --parallel=1`，engine 549 files / 9295 pass / 102 skip，SDK 31 files / 335 pass / 11 skip，kap-server 71 files / 1455 pass / 14 skip，CLI 313 files / 5687 pass / 23 skip，i18n 3 files / 43 pass；合计 16815 pass、0 fail、0 errors、150 skip。engine 的 `test/agent/toolExecutor/toolExecutor.test.ts`、`test/app/capability/windowsCuProcesses.test.ts` 首次失败、隔离复跑通过，保留 flaky 观察；此前被外层 300 秒中断的整包运行不计为通过。五包 typecheck/build、中英文 docs build、构建 CLI smoke、boundaries/no-comments/locale keys/placeholders/t coverage/no-hardcoded-prose 均通过；定向 lint 294 warnings / 0 errors。SDK 的恢复回归另验证请求以 `completed` 完整结束。包版本、锁文件及发布 changelog 未修改；本批未提交或推送。

2.6.3 剩余行为验证（2026-11-20，Bun 1.4.4）：Tower 重测试定向 7 pass；Stop/loop/subagent 定向 117 pass；WebBridge 33 pass；SDK 真实恢复/分叉零请求与后续请求测试通过。按包顺序的 `bun run test --per-file --parallel=1`：SDK 31 files / 336 pass / 11 skip，kap-server 71 files / 1455 pass / 14 skip，CLI 313 files / 5687 pass / 23 skip，三包均 0 fail / 0 errors。engine 修复前运行有 9313 pass / 0 fail / 102 skip，但 `test/agent/toolExecutor/toolExecutor.test.ts` 在 63 个断言通过后产生未处理 `EPERM: operation not permitted, watch` 并以 1 退出；独立运行同样复现，不能把 runner 汇总的 `0 errors` 当作全绿。此前压缩归属测试超时已确认是晚订阅一次性 turn.ended 事件，等待器移到提交前后整个压缩文件 130 pass，未改压缩实现或提高超时。七个相关消费者 typecheck、四包 build、CLI bundle smoke、中英文 docs build、边界/零注释/i18n 门禁均通过；定向 lint 281 warnings / 0 errors。该轮默认引擎整包验收未通过；随后用户已授权独立处理 watcher 生命周期问题，修复与重新验收见后续记录，未关闭监控或吞异常。版本、锁文件、release changelog 未变，未提交/推送/发布；最终版本及发布说明同步仍未执行。

watcher 独立修复与最终验收（2026-11-20，Bun 1.4.4）：根因在 `test/agent/toolExecutor/toolExecutor.test.ts` 的截断夹具，本地 afterEach 删除受监控临时目录早于外层 afterEach 释放配置容器；诊断确认删除时 DisposableStore 尚未释放、ConfigService.dispose 调用次数为 0。保留回归断言，改为先等待 `truncationContainer.disposeAsync()` 并确认真实配置服务只释放 1 次，再删除目录。仅修改测试资源生命周期，生产 watcher、监控开关、依赖版本和超时均未改；测试专用修复不另加用户 changeset。默认配置下 toolExecutor 整文件 63 pass / 0 fail / 无未处理异常；watcher 功能测试 20 pass / 1 平台 skip；`bun run test --per-file --parallel=1` 最终引擎 549 files / 9313 pass / 0 fail / 0 errors / 102 skip [293.6s]，该次无隔离重试提示。引擎 typecheck、定向 lint（75 warnings / 0 errors）与 `git diff --check` 通过。前轮已通过的 SDK 336 pass、kap-server 1455 pass、CLI 5687 pass、七消费者 typecheck、构建/文档/smoke/边界/i18n 结果仍适用于未改变的生产代码。默认引擎验收阻塞解除，2.6.3 已选择的行为补丁均已完成移植或等价验证；最终包版本和发布说明同步仍未执行，未提交/推送/发布。

2.6.3 发行收尾验收（2026-11-20，Bun 1.4.4）：固定来源为发布提交 `b0de2fbd2de04d87689225aafd3912e5d193b62d`（2026-11-17，annotated tag `@moonshot-ai/kimi-code@2.6.3`），不追随后续 `upstream/main`。17 个发行增量中，行为与空补丁判定见上表；#5020 的 changelog 压缩和 #4981 的发行元数据由本轮同步完成。恢复 11 个共享包的冻结版本：CLI 2.6.3、SDK 0.23.2、agent-core-v2 0.6.0、kap-server 0.3.0、klient 0.1.4、pi-tui 0.87.0、remote-control/product/acp-server 0.0.3、migration-legacy 0.1.18、VS Code 0.9.0；fork-only 包版本不变。11 份包 changelog 仅追加冻结提交中缺失的版本前缀，逐字比对通过且本地旧历史完整保留。上游本次 CLI 包 changelog 六条原文为中文，因此包记录原样保留；英文文档忠实翻译，中文文档六条逐项对应，日期均为 2026-11-17，旧文档历史未变。锁文件由 `bun install --lockfile-only --ignore-scripts --no-env-file` 生成，diff 恰为 11 个 workspace version 字段；`--frozen-lockfile` 再验通过，无第三方依赖解析漂移，未运行自动升版或发布命令。

发行审计另发现 #4525 的 SDK/klient 边界漏接，已修复而非仅恢复版本号：SDK 根入口补齐九项 marketplace 运行时导出及 `InstallPluginInput`；Harness、Session、RPC 和 klient 保留字符串兼容并透传结构化输入，避免 `{ source: object }`。klient 结构化输入及 SDK 公共导出回归均先复现失败再转绿；真实本地插件分别经 Harness 字符串调用和 Session 对象调用安装成功。最终源码上按包串行验收：klient 13 files / 122 pass / 35 skip，SDK 31 files / 338 pass / 11 skip，均 0 fail / 0 errors。SDK/klient/kap-server/CLI/VS Code（含 webview）类型检查通过；engine、klient、SDK、kap-server、CLI 构建以及中英文 docs build 通过，收敛无关格式差异后 SDK/CLI 再构建通过。实际 CLI bundle `--version` 为 2.6.3，bundle smoke 通过；SDK 构建产物的 marketplace 导出、解析与更新结果，以及同时消费 Harness/Session 的完整安装输入声明均验证通过，未只检查源码导出。此前最终引擎 9313 pass、kap-server 1455 pass、CLI 5687 pass 的行为验收仍有效，本轮未改它们的生产实现。边界/深层导入、零注释、locale keys/placeholders/t coverage/no-hardcoded-prose 与 `git diff --check` 均通过；定向 lint 153 warnings / 0 errors。构建保留 TypeScript 实验 API、原有 TSDoc、advancedChunks 弃用和 `bun:ffi` 外置提示，未将 warning 报成 error 或隐去。

审计记录同步修正：`ledger.tsv` #4525 补充此前遗漏的 SDK/klient 回归证据；#4870 的“#4843 仍 pending”陈旧描述改为跟随已 ported 的 #4843。仅将本轮八个重复 changeset（gentle-index-fallback、quiet-lamps-retry、steady-model-resume、valid-config-recovery、stop-hook-completed-turn、subagent-final-work、tower-wake-user-origin、windows-webbridge-safe-update）移入回收站，其余 changeset 不动；临时声明消费目录 `.tmp/release-263-check` 已移入回收站并验证不存在，SDK `.tmp-api-extractor` 自动清理已核验。固定 2.6.3 发行增量及本轮发行收尾已完成；这不代表与上游 main 全量无差异，当时 2.6.2 基线 #4876 的文件披露 UI/request_id 仍有分层阻塞，不把版本号当作能力已实现的证据；其后续补齐状态已更新到上表及下方验收记录。保留现有 fork 架构及未提交工作；未提交、推送、发布或创建 PR。

后续补齐与防提前停工验收（2026-11-20，Bun 1.4.4）：#4876 的会话文件披露已使用上游 preview picker 结构接通，支持文件链接、分页、空列表与不可用提示；远程会话仍仅允许 logs，file-history 仍排除。#4830 的原始 tracker/service 已接入本仓 machine requester，真实服务端 request ID 与原 trace ID 分开采集，经 TurnEnded 持久化、恢复和反馈 preview 传递；保留显式 feedback info 的优先级。原始请求元数据由 ProviderDefinition 只对声明支持的 Kimi provider 发送，既有凭据应用改为保留当前请求 headers；本地真实 HTTP socket 验证了 metadata header 实际到达。台账 #4830 改为 ported，不扩大为整个上游 loop 分层迁移。

中途切入 DeepSeek 时以目标 wire model 重建系统提示，切出后移除专属适配，保留 activeToolNames overlay，覆盖重新 bind 与冷 binding snapshot。按用户要求保留内部压力测试工作角色和 unlimited working token budget，不自设 token/轮次/纠偏次数预算；这不是厂商身份或物理上下文无限的断言。普通任务通过已有 onDidFinishStep/loop.notify 拦截三类非终态收尾：只承诺继续、虚构上下文耗尽、把剩余工作推到下一轮。不创建 Goal，不增加纠偏次数上限，保留取消、明确 stopTurn、已有 Goal、只汇报/解释/计划、必要审批和真实 maxStepsPerTurn。Bash、PowerShell、普通 WaitFor 的提前交还控制权建议已同步修正；有限文本识别不代表能识别所有自然语言变体。

最终拥有包验收：引擎项目默认 `bun run test` 为 549 files / 9358 pass / 102 skip / 0 fail [62.28s]，无失败文件或隔离重跑记录；SDK 串行整包 31 files / 338 pass / 11 skip / 0 fail，i18n 3 files / 43 pass / 0 fail；反馈 picker 定向 34 pass / 0 fail，取消/暂停目标/引用文本等边界及实际 outgoing model prompt 均有回归。此前两次串行引擎整包分别为 9356 pass / 2 fail 和 9357 pass / 1 fail，不计为通过：压缩人工预算夹具受全部工具说明长度影响，改为固定 Read + 被测 MCP 工具，并保留原历史缩减断言、增加实际请求工具集断言；任务恢复分类夹具的异步 resumeReminded 标记重写会与 Windows 读盘相遇，只对该无关提醒已交付的夹具设置 resumeReminded，生产恢复/存储行为未改；分类与专门提醒持久化测试 44 pass。没有提高超时、添加重试或放松断言。

本次修复的七个相关消费者类型检查通过（引擎最初的重复测试导入已修正并复验）；i18n、engine、SDK、kap-server、CLI 构建及实际 CLI bundle smoke 通过。这些构建/消费者结果早于随后发生的并行 UI 修改，不代表后者也已通过。边界/深层导入、零注释、双语 keys/placeholders/t coverage、硬编码文案、service naming、prompt ownership 与 diff 检查通过；定向 lint 0 errors，保留既有 warnings。DEVELOP 的 CLI/engine/SDK 三处版本事实也已按当前 manifest 更正为 2.6.3/0.6.0/0.23.2，未更改包版本。验证未调用真实付费 DeepSeek 服务：续跑使用模拟 provider 贯穿真实主循环，请求 headers/响应 ID 另有本地真实 HTTP 验证。

当前整体验收边界：CLI 串行整包在并行 UI 修改期间出现 model-selector 鼠标用例失败（5693 pass / 1 fail / 23 skip）。随后因相关 UI 源码有新修改，再跑项目默认 CLI 整包，仍未通过：`test/tui/tasks-browser.test.ts` 独立复跑 11 pass / 27 fail，`tasks-browser.ts:477` 调用的 `renderTabStrip` 未定义。上述界面/鼠标层属于其他进行中的工作，本次没有修改或回退它们，也没有将整包结果标为全绿；当前 CLI 整包验收仍阻塞，需该 UI 修改稳定后重验。未提交、推送、发布或重新替换系统 exe；本地构建不会热替换当前进程已加载的工具定义。

## 每条的落地顺序

1. `git show <sha>` 读上游改动
2. 在本表找到对应形态
3. 读本地同类实现，判断是"原样搬""需翻译"还是"已经等价"
4. 改代码，同时补测试（测试用 `bun:test`）
5. 跑 `design.md` 的 Gate
6. `bun scripts/upstream-ledger.mjs --probe <sha> <probe>` 记探针，再 `--verify` 推进判定
7. 提交并推送；本表若有新形态，先补行

### 2.7.0 T9/T10（2026-11-21）

- **#4820/#4630 已完成**：`packages/core` 接住 2.7.0 的 loop/llm/tool；`agent/loop` 18/21
  文件逐字节相同，3 个适配是 `Bun.CryptoHasher`（llmRequestOps/requestObservation）与
  `loop.ts` 删除一条注释；**#4831 的 retry/task 行为**已随 loop 重构落地（journal 的
  `llm.retrying`/`llm.sent`、`turnProjection` 清理 retry、taskService 的
  `onDidChangeTask`/detached lease），不再以“阻塞在 #4630”收尾。
- **LLM requester 对齐**：fork 独有的 `AgentLLMRequesterService` 保留为适配层，内部改为
  `IAgentLoopService.prepareOperation` + core `InitializedLlmRequester.generate`；旧
  `ModelRequester`、旧 fullCompaction 生成器、旧 human machine/session/tool/persist 内核
  删除；PowerShell 改到 executor 的 `set/detach/write` 任务模型。
- **PDF 能力**：core message 增加 `document_url`，Anthropic/Google/OpenAI/Responses 四个
  协议 lowering 补齐；这是本 fork 对 core 的显式扩展（上游 2.7.0 无 document part），
  不是把 PDF 当视频或类型 cast。
- **构建**：`agent-core-v2/tsconfig.json` 保留 Bun 运行时需要的 paths；新增
  `tsconfig.build.json`（`paths: {}`）供 tsdown dts，解决了 core `protocol.ts` 的
  tsgo dts 失败。
- **治理判定**：#5019 以三包零注释区 + 空 baseline 判 equivalent（范围收窄但规则同源）；
  #5023/#5072 判 not-applicable：本仓没有 upstream 的 `scripts/checks` 注册表/
  `.oxlintrc.ratchet.json`，AGENTS.md 由 `merge=ours` 持有，治理层是 `tools/review` + `check:*`，
  不把上游 CI 框架整体搬入。
- **未决红项**：loop 的 aborted-turn resume 比较、coreLoopService 的 max-steps 超时、
  taskManager 的 Bun `toFake` 语义差异；不计为已通过。

- **构建链**：CLI prebuild 仍调用 pnpm；已改为 `process.execPath` + workspace cwd
  （`sync-web-dist`、`build-vis-asset`、`native/web-assets` 及其提示），
  `apps/kimi-code && bun run build` 与 `bun run smoke` 通过。human 内部 `#human/*`
  由 `src/human/package.json#imports` 解析，build tsconfig 的 `paths: {}` 不再破坏 rolldown。

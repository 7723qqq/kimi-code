# 实现设计

## 已确认的事实

- 目标发布来自固定提交 `a5e355e2718a2ebf70d8229fa5a05fe35d5f98a1`，不是 canary 或当前 main。
- Desktop 在目标树中为 Electron `45.1.0` + Vue 3，入口是 `apps/desktop/src/main/app/index.ts`；目前本地 `apps/desktop/package.json` 不存在。
- 上游 `src/main/server/embedded-server.ts:startDesktopServer` 直接在 Electron 主进程调用 KAP `startServer()`，随后把 `handle.core` 传给浏览器 MCP 注册、对话框 reminder 和 telemetry。只替换 package scripts 不足以实现 Bun 后端。
- 本地 KAP 已在鉴权、请求指纹、搜索及会话投影中使用 `Bun.CryptoHasher`，引擎还有其他 Bun API。Bun 的 Node API 兼容是 Bun 执行 Node 风格代码，不会反向给 Electron 的 Node 环境提供 `Bun.*`。
- 本机 Bun `1.4.4` 已实测支持 `node:fs`、`node:events`，并报告 `process.versions.node=26.3.0`。该字段不是外部 Node 安装证明，也不证明所有 native addon/宿主 API 可互换。
- 上游提供 `apps/kimi-code/scripts/sync-web-dist.mjs`；本仓已有 `tools/bun-migrate`、包测试 runner 和 `scripts/upstream-ledger.mjs`。复用这些入口，不另造下载/测试/同步流水线。
- 当前 ledger 的 refresh 硬编码追踪移动的 `upstream/main`，不适合直接充当固定发行清单；GitHub compare 的文件列表又有 300 项上限。

## 总体方案

采用“固定发行源 + 分语义移植 + Electron 宿主/Bun 后端”的单一路径。保留本 fork 的有效能力与 machine 引擎，按目标版本对齐上游用户行为和公共契约；不将整个工作区重置成上游。

```text
Bun 开发/构建/测试入口
  ├─ Vite + Vue → Desktop renderer / Web variant
  ├─ tsdown → Electron main / preload
  └─ 既有 Bun native pipeline → Desktop 后端可执行文件

Electron main / Chromium renderer
  ├─ 窗口、协议、托盘、截图、node-pty、内置浏览器
  ├─ 受限 JSON 控制通道 ↔ Bun Desktop backend
  └─ renderer HTTP/WS ↔ Bun KAP + 现有 machine 引擎
```

这里不存在要求用户安装的第二个 Node。Electron 自带宿主运行时保留其边界，业务后端和开发工具由 Bun 执行。

## 1. 来源获取、工作区保护与发行台账

### 保护现有工作

实施前记录 HEAD、工作区状态、受影响脏文件的精确差异与未跟踪文件清单。用 Git 的二进制 diff 输出保存 tracked 基线；需要修改的未跟踪源文件保存单独内容快照，排除凭证和真实用户数据。备份只放在本任务的临时目录，验证补丁可读取；不创建 stash、不提交用户工作。

每个语义组开始前重读本地文件和其当前差异。若存在同时发生的新修改，重新合并该文件的变更，不对陈旧后像进行覆盖。Write/Edit 的历史快照是补充，不替代整次差异基线。

### 固定完整 source

取得正式 tag/目标 Git 对象后核对 peeled SHA，使用完整 tree 和 merge-base 之后的历史清点，而不以 compare API 的部分文件集合为准。此前 tag fetch 超时，实施先恢复标准 Git 获取；可在单次命令中选择 HTTP/1.1 和 blob filter，不修改全局 Git 配置。若对象仍无法获取，报告来源获取阻塞，不用未验证的混合 main 文件替代。

### 扩展现有 ledger 工具

在 `scripts/upstream-ledger.mjs` 增加 `--ref <commit-or-tag>`，用于 `--refresh`、`--verify`、`--report`：

- 显式 ref 在本地解析为 commit；显式模式不 fetch 移动 main、不改已有默认行为。
- refresh 只添加目标可达、main 未含、ledger 未记录的提交；已有行的 verdict/evidence 不被重置。
- verify/report 的 ref 模式仅选择目标可达的行，避免本次验收改变目标之外的工作状态。
- release-only 与主线回合并按实际可达性和 patch identity 归并，避免反向撤销 2.6.3 修复。
- 对 #5079 这类单提交含多个子系统的迁移，台账证据必须枚举源码、共享包、Web、构建、CI、测试的落点，不能用一个 grep 证明整项完成。

新增回归放在 `scripts/test/upstream-ledger.test.ts`。实现时继续使用既有 probe/verdict/cluster 命令，不手工维护另一本进度账。

## 2. 后端与协议先于新客户端

### API 收敛

对照 #4891、#4963、#4965 原始 diff，把 `routes/v2/sessions.ts`、`routes/v2/mcp.ts` 的有效能力并入 `/api/v1` 所有者；更新 `registerApiV1Routes.ts`、协议 schema、WebSocket frame、OpenAPI/AsyncAPI 和 API surface 快照。完成仓内调用迁移后移除目标版本已删除的注册入口，不长期保留 v1/v2 两套实现。

逐项列出旧路径、旧字段和消费者，迁移 `packages/klient`、`packages/node-sdk`、CLI、VS Code、调试客户端、Desktop app-client。上游仍保留的兼容语义照原补丁保留；fork-only transcript/Operation Log 扩展保留自己的显式契约，不冒充上游状态字段。

### SSH full-server hosts

导入并接通目标版本的 `app/hostsConfig`、`app/hostFolderBrowser`、`kap-server/src/routes/hosts.ts` 和 `services/hosts/*`。SSH full-server 与现有环境执行器按其各自职责保留，不把前者降格成远程文件执行。聚合排序、分页、grouped routing、项目发现、断开/重连及诊断以固定目标的最终实现为准。

### 引擎和 SDK

把预测服务、KAP wait/interactions、host identity、Bash ID env、Vertex ADC、Claude 5 输出限制等分别接入现有所属服务。模型相关补丁落入本 fork `human/llm`、`llm-adapter` 和既有 requester，不建立平行请求链。

`packages/core` 的所有适用行为必须映射到实际生产路径；纯上游内核抽取/目录扁平化在 PLAYBOOK 记录结构差异。当前设计不新增无人使用的 core loop，也不以“没有 packages/core”关闭任何行为缺口。若某公共契约无法由现有架构正确承载，记为具体阻塞并修订设计，不伪造等价判定。

## 3. 新共享包与测试基础设施

导入七个 `app-*` 包、`vite-preset`、`testkit`、`tests/scenarios` 和 `scripts/icon-tools` 的目标源码、资源与许可。新增叶 workspace 也登记到根 workspace 和 Nix 文件集。保留 Vue 组件源，不为了统一既有 React 工具而重写 renderer。

先对新增目录运行现有 `tools/bun-migrate` 的只读 scan，审核报告后只翻译本次新增文件与必要接线；禁止对整个脏仓库执行 apply。将上游 Vitest mocks/setup 迁入 `bun:test` 与包级 preload，保留测试断言和场景。新包的同目录/`src` 测试必须通过各自 runner roots 被发现。

Desktop 和 Vue 共享包若需要 SFC/虚拟资源加载，复用 `vite-preset` 的 Vue、icons、raw assets 规则为 Bun test 提供测试加载入口；不把 `.vue` 替换成空组件以获得通过。Playwright 保留真实 Electron/浏览器执行，由 Bun 驱动，不把运行测试驱动的 Bun 与被测 Chromium 混为一谈。

`testkit` 协议 fake model 与现有 `mockUpstream` 各自已有消费者的 API 先保留，通过共享协议事实测试防止行为分叉；不在发行合入中顺便替换全部测试夹具。

## 4. Desktop Bun backend 的进程边界

### 模块落点

- `src/main/server/embedded-server.ts`：改为受管理后端启动适配，保持 `DesktopServerHandle` 的 origin/port/close/shutdownTelemetry 语义。
- `src/main/server/connect.ts`：仍管理 single-flight 初始化、外部服务器选择、renderer load 与退出次序。
- 新增 `src/backend/entry.ts`：仅由 Bun 执行，调用 KAP `startServer` 并注册引擎侧 Desktop 集成。
- 新增 `src/shared/backend-protocol.ts`：运行时校验的 JSON 请求、响应与事件类型，不携带 Scope、函数或异常实例。
- 新增 `src/main/server/bun-backend.ts`：Electron 侧进程、控制通道与生命周期所有者。
- 浏览器注册/对话框 reminder 中只依赖引擎的部分移到 `src/backend`；Electron 浏览器与系统能力留在 `src/main`。

### 控制通道契约

使用受管理子进程的私有 stdio JSONL 通道；人类日志走 stderr，不混入协议 stdout。所有 request/result 用 id 配对，事件携带 session/agent/generation 等真实身份。只有预定义动作可分发，未知版本、未知动作、畸形消息或重复 reply 产生明确协议错误。

启动消息包含运行参数、host identity、资源路径和 Desktop 集成配置；ready 仅在 KAP 真正监听且集成完成后返回 origin/port。开发态明确启动仓内 Bun entry；打包态只启动安装包资源中的配套后端 EXE，不走任意 PATH 猜测。

取消时清理对应 pending request；close 幂等，退出中拒绝新请求，先关闭 KAP、MCP、reminder、telemetry，再结束子进程。启动失败、EOF、进程退出都使未决请求失败并返回可见原因。父进程消失由通道 EOF 触发后端清理；不得依赖 Electron 退出自动带走子进程的假设。

### 不能遗漏的跨进程能力

上游直接消费 `handle.core` 的代码必须完整拆分：

- browser MCP 的 session ephemeral server 注册、dynamic tool disclosure、执行策略与 kept-session 语义在 Bun 引擎侧。
- 主/子代理浏览器资格、generation/turn 归属、run 撤销在同一所有者维护；shell 通过有序事件和请求获取事实，不能各自维护不一致的授权真相。
- Electron 侧控制开关变化通过通道更新；每次浏览器执行仍检查当前权限，不能因旧缓存继续操作。切断通道时 fail closed。
- 对话框 collect/forget、turn reminder、SubagentSpawned/TurnEnded 与 run 完成/撤销事件通过明确消息过边界。
- telemetry 的事件与关闭保持原配置开关，不因进程拆分重复上报或绕过退出 flush。
- Desktop 鉴权保持 `server-auth.ts` 的原安全语义。临时秘密仅经私有启动通道传递，不放命令行、就绪日志或普通诊断文本；保持 loopback、Origin/Host/CORS 和 Electron contextIsolation 边界。

## 5. Bun 构建、native 模块和资源

扩展既有 native pipeline，而非另写 Bun 下载器。后端使用 `bun build --compile`，作为 `electron-builder.config.cjs` 的 `extraResources` 加入目标平台资源目录；它与 Desktop/CLI 构建使用同一源码版本。

Electron main/preload 的 tsdown 输出继续面向 Electron，不能混入 Bun-only 后端 bundle。`node-pty` 与截图等 native 资源按 Electron ABI/平台构建或选择 prebuild，构建脚本由 Bun 执行；不能把 Bun 的 Node API 兼容当作 native addon ABI 已验证的证据。

修改上游现成的 `scripts/dev.mjs`、`scripts/rebuild-native.mjs`、`e2e/run.mjs`、package scripts 与相关 workflows，消除本仓流程对外部 node/npm/pnpm 的启动依赖。Electron 本体及必须在其宿主内执行的代码不做机械 `Bun.*` 替换；`tools/review` 的运行时分类增加明确 Electron 归属，不通过全目录忽略隐藏其他缺口。

## 6. Web、版本与文档

翻译并复用上游 `sync-web-dist.mjs`：先构建 `apps/desktop/web-dist`，确认入口有效，再完整替换 CLI 的 `dist-web`，不叠加旧 hash generation；失败时保留上一次有效产物。CLI build 依赖该源码构建结果，桌面本地服务使用 desktop variant。

共同包 manifest 与 changelog 对照固定发布提交更新；`bun install --lockfile-only --ignore-scripts --no-env-file` 生成锁文件，随后 frozen 安装核对。Desktop/Electron/native 构建所需 lifecycle 脚本按依赖审查后显式运行，不静默扩大所有依赖的执行权限。

更新 `DEVELOP.md` 中“无 Vue”“桌面源码未跟踪”“Web 来自外仓”等不再真实的项目事实，补充实际 Bun 命令和 Electron 边界。双语用户文档覆盖新 API、hosts、KAP、预测与任务交互；CLI/Desktop 版本各按上游，不把 Desktop 标成 2.7.0。

## 验证与交付

按 `tasks.md` 的依赖次序完成，每组先定向用例，再拥有包验收；共享契约改变后运行明确列出的消费包。对新 Desktop 同时验证开发态和未签名打包目录，fake model 驱动实际聊天、权限、任务和浏览器，不只检查 import。

本次不运行安装器、不接触真实用户登录态。最终报告区分源码/构建/运行验证、平台限制及任何未闭合项，不能把“产物存在”当作整版已经对齐。

## 未采用的方案

- **直接 merge/checkout 上游整树**：会覆盖大量未提交 fork 能力，并把 pnpm/Node 假设带回本仓。
- **仅把 npm/pnpm scripts 改为 bun，仍在 Electron 内嵌整个 KAP**：后端仍由 Electron 的运行时执行，且现有 Bun-only API 会失效，不满足用户的 Bun 后端要求。
- **把全部 Bun API 改回 Node API**：破坏已批准的 Bun 运行时和打包路线，仍未使引擎在 Bun 中执行。
- **另选桌面框架实现纯 Bun 窗口**：意味着重写浏览器、截图、终端和系统集成，超出本次上游对齐。
- **强制改用上游 core loop**：本次没有要求用内部结构重写替换 fork 机器内核；会扩大记忆、工具、权限与任务续跑的迁移面。保留结构差异，但不排除任何目标版本行为或协议。

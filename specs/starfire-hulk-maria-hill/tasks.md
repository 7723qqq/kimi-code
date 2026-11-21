# 执行任务与验收

实施优先级为 P0 → P1 → P2，按依赖顺序逐项闭合。下列命令中新增的 scripts 是本规格要接通的交付接口，不代表当前已经存在或通过。项目命令与 runner 使用方式以实施时所属包为准。

## P0：可靠来源与共同基础

### T01 保护基线并获取固定完整源

- [ ] 记录当前 HEAD、tracked diff、未跟踪源文件清单与本次需要修改的未跟踪文件快照。
- [ ] 获取正式 tag/Git 对象，核对目标 SHA，完整列出目标文件树及与本地的历史关系。
- 验收：tag 的 peeled commit 等于 `a5e355e2718a2ebf70d8229fa5a05fe35d5f98a1`；清单未标 truncated；tracked 差异快照包含所有现有脏文件且可解析；没有 stash、reset 或覆盖旧工作。若源不可获取，来源任务保持阻塞，不进入猜测式移植。

### T02 让既有台账支持固定 ref

- [ ] 为 `scripts/upstream-ledger.mjs` 的 refresh/verify/report 增加 `--ref`。
- [ ] 在 `scripts/test/upstream-ledger.test.ts` 覆盖有效 tag、SHA、无效 ref、分叉历史、已有判定保持及目标外行不被改写。
- [ ] 按固定目标补全提交/行为清单，拆出 Desktop 大提交的子能力证据。
- 验收：无效 ref 非零退出且 ledger 字节不变；显式 ref 不 fetch main；两次相同 refresh 不新增重复行；新目标不会重置旧 verdict；ref-scoped verify 不改变不可达行。执行该测试文件后，发行清单对全部目标适用改动都有落点与待验证状态，不用 commit 数字替代功能进度。

### T03 导入共享包、工作区和测试接线

- [ ] 导入七个 app-* 包、vite-preset、testkit、场景测试与图标工具的固定源码、资源和许可证。
- [ ] 使用既有 bun-migrate scan 审核翻译，接通 Bun scripts、preload、Vue 所需测试资源加载及 runner roots。
- [ ] 更新根 workspace、catalog、Nix 文件集、拥有包 typecheck/test 发现规则。
- 验收：每个新增 workspace 的实际包名能被现有 catalog 枚举；有测试的新增包运行时测试数量非零；`.vue` 测试不被空模块替代或整组跳过；包测试由 `bun:test` 执行，场景驱动不启动外部 node/npm/pnpm。对每个新增包逐个执行其测试与类型检查。

### T04 对齐服务端契约并迁移所有仓内消费者

- [ ] 完成 #4891/#4963/#4965 的 v1 路由、cancel、紧凑状态与事件形状，记录旧→新契约清单。
- [ ] 同步 klient、SDK、CLI、VS Code、调试客户端及新 app-client；更新 API surface、OpenAPI/AsyncAPI 和 wire/config/state 生成产物。
- [ ] 保留 fork-only transcript 与 Operation Log 的显式扩展。
- 验收：真实 HTTP/WS 用例覆盖创建、列表/分页、提交、取消、恢复、订阅与交互；旧入口的存在/移除及响应与固定目标一致；未知 body 字段仍被拒绝；无仓内消费者继续调用已删除入口。KAP、klient、SDK、ACP、CLI、VS Code 及 app-client 的类型检查和对应契约测试通过。

### T05 完整接通 SSH full-server hosts

- [ ] 导入 hosts 配置、folder browser、server bridge/proxy/fanout 与路由。
- [ ] 移植目标最终版本的 grouped routing、全量排序、分页、重连、失败原因及项目发现修复。
- 验收：受控 SSH 协议夹具验证本地与两个远端同名项目/会话不串路由，分页无丢失或重复，投影发生在全量排序后；空闲 host 可重连，移除再恢复 host 后会话重新可见；一个失败 host 不使其他项目列表不可用，且错误原因可见。真实 SSH 联调若缺目标环境，单列未验证项，不冒充已完成真实远端验证。

### T06 补齐引擎、认证、SDK 与 KAP 行为

- [ ] 核对并完成预测服务、ACP capabilities、stale BTW reload、host product、Bash IDs、KAP wait/interactions/kap.md、web --json、Vertex ADC、Claude 5 ceilings、更新 rollout、Remote Control proxy、WebBridge partial update。
- [ ] 按生产调用链审计上游 core 改动；为每个保留结构差异记录原变更、能力落点与测试。
- 验收：fake model 的真实 socket 请求能证实目标模型认证/请求形状；Vertex ADC 选择在无 API key 的夹具下成立、显式 key 优先级不变；Bash 真子进程读到正确 session/workspace ID；机器可读启动输出可被 JSON parser 直接消费，日志不污染其契约；KAP HTTP wait 在运行/终态/取消场景返回目标结构，interactions 可完成一次审批/提问。相关 owning tests 与 SDK/KAP 消费场景通过；不需要真实付费模型凭证。

## P1：Desktop 的 Bun 运行时与交互闭环

### T07 建立 Electron ↔ Bun 生命周期通道

- [ ] 实现 backend entry、shared backend protocol 和 bun-backend owner。
- [ ] 改造 embedded-server/connect 的初始化、就绪、外部 server 路径与关闭。
- 验收：开发态进程实际报告 Bun `1.4.4`；只有完成监听和集成后才发送 ready；并发 connect 只启动一个 owned backend；未知协议、启动失败、取消启动、EOF、异常退出均使 pending requests 失败而不悬挂。close 重复调用只关闭一次；退出后子进程和监听端口均消失，退出期间不再接收新请求。

### T08 迁移引擎侧 Desktop 集成而不丢浏览器能力

- [ ] 迁移 browser MCP/session 注册、tool disclosure/策略、子代理 run 归属、dialog reminder 与 telemetry 到正确进程。
- [ ] 为 shell-only 能力建立明确控制消息，不跨进程传递 Scope/函数。
- [ ] 保留鉴权、开关、kept session 与撤销语义。
- 验收：主代理和具备资格的子代理可调用内置浏览器；explore/禁用策略仍拒绝；关闭控制开关后符合目标版本的既有会话保留语义被测试覆盖，新无权请求不执行；turn/session/generation 变化不会复用旧授权。浏览器对话框提醒能在下一用户轮出现一次，删除会话会 forget；通道断开拒绝执行。坏 token/错误 Origin 被拒，secret 不出现在 argv、ready 输出或日志。telemetry 配置关闭时两进程均不新增上报。

### T09 导入完整 Desktop UI、native 与 Bun 开发链

- [ ] 导入 Desktop main/preload/renderer/native 源码与资源，接通七个 app-* 包。
- [ ] 翻译 dev/rebuild-native/e2e/构建脚本，保留 Electron 运行时所需模块与 ABI。
- [ ] 将 Electron 文件从 Bun-only API 建议中按运行时准确分类，其他 backend 仍受原门禁覆盖。
- 验收：`bun run dev:desktop` 可启动并连接 Bun backend；`bun run --filter kimi-code-app typecheck`、Desktop 拥有包测试通过；renderer 真实渲染，不出现 `Bun is not defined`/native addon ABI 错误；终端能执行并显示一条命令，截图/浏览器的本机适用 native 资源可加载。执行不依赖外部 node/npm/pnpm；不可用平台能力有显式诊断，不吞错误假成功。

### T10 补齐 CLI/TUI 可见能力

- [ ] 合入预测 ghost text、多行反馈、前台 agent activity，以及其余固定目标 TUI 差异。
- [ ] 与现有鼠标、任务面板和选择器改动逐 hunk 合并，不覆盖其未提交工作。
- 验收：预测请求取消后不显示旧建议，用户输入不被 ghost text 覆盖；按目标键位接受/忽略预测；反馈保留换行；前台运行任务在 /tasks 可见且停止后状态正确；既有 queue/steer、鼠标控件与 compact transcript 用例仍通过。定向 TUI 测试、CLI 类型检查及实际终端 smoke 通过。

### T11 在本仓重建并同步 Web

- [ ] 翻译上游 sync-web-dist，接通根 build:web/sync:web 与 CLI Web 资源构建依赖。
- [ ] 从 Desktop renderer 构建 Web variant，同步完整新 generation。
- 验收：`bun run build:web`、`bun run sync:web` 与 `apps/kimi-code/scripts/check-web-assets.mjs` 通过；同步前构建失败不破坏旧有效目录；成功后入口引用的全部资源存在，旧 generation 不残留。真实 Web 会话可创建、恢复、审批和取消；未提供的桌面原生能力不伪装成可用。

### T12 打包独立 Bun 后端并验证 Desktop 目录产物

- [ ] 复用 native pipeline 生成本平台后端 EXE，接入 electron-builder extraResources。
- [ ] 构建未签名 Windows 目录产物，不运行安装器。
- 验收：`bun run --filter kimi-code-app build` 和目录打包命令通过；包内后端与本次源码版本一致；移除测试子进程对系统 Node/Bun/CLI 的 PATH 依赖后，打包桌面仍能聊天。Bun backend 报告实际运行时而非伪造字段；关闭桌面后无孤儿后端/端口；资源路径含空格时仍可启动。

## P2：发行一致性与最终验收

### T13 同步固定版本、依赖、说明和开发文档

- [ ] 对照固定目标更新共同包 manifest/changelog，保留 fork-only 历史和未消费 changeset。
- [ ] 用 Bun 生成锁文件，核对新增依赖与 native lifecycle，更新双语用户文档及实际项目结构说明。
- 验收：CLI `2.7.0`、Desktop `1.4.0`、KAP `0.3.1`；全部共同包版本与固定目标一致；fork-only 包未升版；`bun install --frozen-lockfile --ignore-scripts --no-env-file` 不改锁文件。中英功能条目对应，文档不再声称 Desktop 源码仓外或本仓没有 Vue；文档构建通过。没有 version/publish/上传行为。

### T14 全链路发行回归、自审与清理

- [ ] 按拥有包串行运行新共享包、engine、KAP、klient、SDK、ACP、Remote Control、product、CLI、VS Code、testkit 和 scenarios 验收；按实际 diff 纳入其余消费包。
- [ ] 运行对应类型检查、构建、`check:lint`、新增资源/运行时门禁、ledger 固定 ref verify/report 与结构 review。
- [ ] 用 testkit fake model 驱动实际 Desktop/Web：打开工作区→新会话→发消息→工具审批/问题→后台任务→中途切模型→取消→恢复会话→退出。
- [ ] 重验 fork 保护项：DeepSeek 切入/切出、非终态结束纠偏、记忆注入隔离与可见性、Operation Log、GitHub proxy 以及权限拒绝。
- [ ] 阅读最终相对基线的完整 diff，核对状态和本次临时资源，清理本次测试输出与服务，保留用户原文件。
- 验收：交付 CLI bundle 显示 2.7.0 并通过原生/bundle smoke；桌面开发态和目录产物上述关键场景通过，Web 同契约场景通过；所有任务范围内失败已解决，skip 有具体平台/能力原因；固定目标没有未解释的适用功能缺口，不能靠新增 not-applicable 掩盖未实现行为。最终报告列命令、结果、平台边界和残留阻塞；任何必需项未闭合则明确报告未完成，不安装系统 EXE或发布。

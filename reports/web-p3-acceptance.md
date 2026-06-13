# kimi-web P3 落地验收简报

> 验收对象：P3 落地（goal / swarm / subagent + 激活徽标 + terminal + 视图分屏），由他人完成。
> 验收方法：代码静态审查 + 真实浏览器实景冒烟（隔离 stub + vite）+ 单测/类型/lint/生产构建。
> 落地提交：`f5a7f21c feat(web): land P3 …`（验收前为未提交工作区，已整批落成一个内聚提交）。

## 结论

**可以验收，未发现需要修复的严重问题。** 6 块功能在真实界面下全部正常渲染与交互，关键集成链路（goal 响应式、终端重连重放、子代理完成态）经核查正确；单测 98 全过、`vue-tsc` 0 错、`oxlint` 0 错、生产构建通过。

按「只修复严重问题」的要求，本轮**未改动任何代码**（无严重项）。下面列出几个非阻塞的小建议，留给你决定是否后续处理。

## 逐区域验收

| 区域 | 结论 | 依据 |
|---|---|---|
| 子代理生命周期投影 | 通过 | `subagent.spawned→started→suspended→completed/failed` 经 `patchSubagent` 维护全量，completed/failed 先发带 `subagentPhase:'completed'/'failed'` 的 `taskCreated` 再发 `taskCompleted`，所以完成后 phase 不会卡在 working；`subagent-goal` / `agent-group-turns` 单测覆盖。 |
| 内联 Agent / AgentGroup 卡 | 通过 | 浏览器实景渲染 3 张 agent 卡；`messagesToTurns` 聚合 + `toAgentMember` 派生 phase 正确。 |
| swarm 内联多列卡 | 通过 | 渲染 `.swarm-card`（多列 `.mcell`）；`swarm-groups` 单测覆盖按 `swarmIndex` 聚合/排序/计数。 |
| goal 常驻条（可展开） | 通过 | 浏览器实景在 dock 上方显示「GOAL … active …」并可展开；reducer `goalBySession` 已在 `applyEvent` 的快照+回写两端都接上，WS 事件能响应式更新（核查过，非靠快照掩盖）。 |
| 激活徽标 plan/goal/swarm | 通过（含一处小 UX） | `activationBadges` computed 从 planMode/goal/swarm 正确派生，Composer 状态行渲染 `.abadge`。小问题见下「非阻塞 #2」。 |
| Terminal（普通 tab） | 通过 | 在**符合契约的 stub** 下 xterm 正常出 prompt、无报错；WS `terminal_*` 帧 + `onServerHello` 用 `lastSeq` 重 attach（since_seq 重放）正确。早先看到的崩溃是**测试假象**，见下「澄清」。 |
| 视图分屏（tab 维度） | 通过 | SplitLayout/ViewGroup 渲染 5 个视图 tab（对话/文件/后台任务/待办/终端）+ 分屏按钮；`usePaneLayout` 的 split/close/resize/normalize/持久化逻辑健全（守住最后一组、折叠单子节点、加载时防御性 normalize）。 |

## 一处澄清：终端「Cannot read properties of undefined (reading 'map')」是测试假象，不是产品 bug

冒烟初期终端 tab 报这个错。定位后确认：当时 vite 代理指向的 7900 端口上是一个**遗留的旧 stub**（没有 `/terminals` 路由），`GET /sessions/{id}/terminals` 返回 `data:{}`，客户端 `listTerminals` 的 `data.items.map(...)` 因 `items` 缺失而抛错。换成**当前修改版 stub**（正确返回 `{items:[]}`）后终端完全正常。真 daemon 按协议返回 `{items}`，不会触发；旧 daemon 无该路由会走 404，被 `useTerminal` 的 try/catch 优雅兜住。故判定非严重、不修。

## 非阻塞建议（本轮按要求未改）

1. **list 方法缺 `?? []` 防御（含 `listTerminals`）**：`data.items.map(...)` 在响应缺 `items` 时硬崩，且终端的失败态是「原始报错文本充满终端」，观感差。这是全代码库 list 方法的统一写法、真 daemon 不触发，故非严重；但终端是新功能、失败态难看，可考虑 `data.items ?? []` 一行兜底。
2. **激活徽标在审批/提问占用 Composer 时不显示**：徽标在 Composer 状态行，而 pending approval/question 会替换 Composer（P1-8 行为），此时 plan/goal/swarm 徽标暂时消失。goal 仍由常驻条覆盖，影响小；如要常显，可把徽标行提到 dock 顶部独立渲染。
3. **滚动跟随的 MutationObserver 切视图后不重绑**：`contentObserver` 仅在 `onMounted` 绑到当时的 `panesRef`，组内「切到终端再切回对话」后新 `.group-panes` 没有重绑 MutationObserver。数据驱动的流式跟随由 `watch(scrollKey)` 兜底仍生效（P0-3 主路径不丢），但 markdown 重高亮/图片加载等非 Vue 跟踪的变更不再触发跟随。建议在 active 视图变化时重绑 observer。
4. **terminal / usePaneLayout 缺单测**：`useTerminal`、ws 终端帧、`usePaneLayout` 没有专门单测（其余区域有）。逻辑读下来正确，但建议补 `terminal-ws` / `use-pane-layout` 单测固化（计划里原本列了）。
5. **`pnpm-workspace.yaml` 多了 `catalog: zod: 4.3.6`**：与 P3（xterm）无关、来历不明。若无包以 `zod: "catalog:"` 引用则为惰性配置、无害；建议确认是否有意添加，避免日后 zod 版本被意外统一。

## 验证记录

- `npx vitest run`（apps/kimi-web）：**20 files / 98 tests passed**（新增 `swarm-groups` / `subagent-goal` / `agent-group-turns`）。
- `npx vue-tsc --noEmit`：passed（0 error）。
- `npx oxlint src`：0 errors，67 warnings（既有风格类）。
- `npx vite build`：built in ~6s，xterm 入包；仅既有 large-chunk 警告。
- 浏览器实景（隔离 stub@7913 + vite@5193，kimi-webbridge 驱动真实浏览器）：onboarding → 选会话 → 发 prompt → SplitLayout/ViewGroup 5 tab、终端 xterm、goal 常驻条、swarm 卡、agent 卡、审批卡入 dock、悬浮任务卡、composer + plan 开关，均正常；无 console 错误。
- 关键集成静态核查：`applyEvent` 快照+回写含 `goalBySession`（goal 响应式 OK）；`onServerHello` 终端重 attach 用 `lastSeq`（重连续流 OK）；`subagent.completed/failed` 的 phase 正确（不卡 working）。

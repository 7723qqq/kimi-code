# 全屏 TUI 鼠标点击：实施与验收计划

以下步骤在规格审批后执行。按 `T0 → T1 → T2 → T3/T4/T5 → T6` 推进；组件各批验证通过后继续下一批，不等待额外确认。实现阶段记录实际结果，审批阶段不改源码、不运行应用构建。

## T0 · 锁定基线和最小复现（R1–R6）

- [ ] 用 `git status --short` 记录已有改动；以现有 `VirtualTerminal`、任务和审批测试替身为起点，不改用户原有工作。
- **验收**：对同坐标 `0M/3m`、切换画面后旧释放、任务「更多」覆盖真实行、模型分段和任务筛选没有动作，先保存可重复的源码/测试证据，修复项的定向用例在变更前能复现异常。另固定普通模式和全屏直连/复用器的启动/退出鼠标输出，作为不改变上报的对照。

## T1 · 修复终端已经送达的点击判定（R1、R2、R6）

- [ ] 在 `packages/pi-tui/src/tui-alt-screen.ts` 和必要的浮层命中辅助方法实现成击校验；只从 Kimi 全屏装配启用。更新 `packages/pi-tui/UPSTREAM.md`。
- **验收**：`tui-alt-screen.test.ts` 从 `VirtualTerminal.sendInput` 发送实际 SGR 字节；普通释放和通用释放的同格左键手势各发一次 `click`，通用释放传给组件的是 `left`。孤立释放、左右键不匹配、按下后拖出又拖回、失焦/复焦、换布局根、缩窗和新浮层遮挡的旧手势各发零次回调；下一次有效点击仍发一次。保留同目标的普通重绘场景，仍发一次。测试同时覆盖组件接手按下和仅在成击响应的路径。
- **反向验收**：移除归一逻辑或失效检查，相应的回归用例重新失败；原有搜索、跳到底部、滚动条、拖选、双击选词、链接、粘贴与滚轮用例不改语义。直连和复用器不新增或扩大任何鼠标上报序列；普通模式不发新上报；退出或暂停后的关闭序列仍生效。

## T2 · 让命中范围与可见画面一致（R2、R6）

- [ ] 在 `utils/mouse.ts` 复用局部坐标、焦点交接和稳定窗口；为本次控件提供范围/业务身份校验。`gutter-container.ts` 复用已渲染布局，不再为点击重画来猜高度。
- **验收**：`utils/mouse.test.ts` 和 `components/chrome/gutter-container.test.ts` 覆盖 CJK/窄列、边界 `start` 命中而 `end` 不命中、两侧外边距/间隔/空行均零回调；禁用、裁掉、卸载及按下后 ID 替换均零回调。连续输入不会创建额外监听或为命中重新渲染子树，合法目标的现有焦点/滚轮转发正常。

## T3 · 模型思考分段与供应商标签（R3）

- [ ] 扩展 `model-selector.ts`，修正 `tabbed-model-selector.ts` 的标签时机，沿用思考草稿和标签坐标换算。
- **验收**：在 `model-selector.test.ts`、`tabbed-model-selector.test.ts` 覆盖平铺、带标签、支持多档、仅 On/Off、不可切换模型和无控件选项；点击可见分段改变高亮但 `onSelect` 和会话专用回调均为零，随后按 `Enter` 只提交一次期望的 `{ alias, thinking }`。无修饰左键松开后只切一个标签、不提交模型；按下未松、拖动、非左键、点在标签间隔、被截断标签或切页后旧坐标均不切换/误提交。键盘 `Tab`、箭头、`Enter`、`Esc` 和已有 `Alt+S` 覆盖保持通过。

## T4 · 后台任务筛选、选行和查看（R4）

- [ ] `TasksPanelComponent` 接通已显示标签、查看输出和返回；按可见任务 ID 校验列表动作。`BackgroundTasksMiniPanel` 转发实际可见子区域，接通放大/关闭，不改停止确认和任务加载逻辑。
- **验收**：`test/tui/tasks-browser.test.ts` 用带 ID 的任务验证命中三个标签发正确 `onTabChange`，点行最多发一次同 ID 的 `onSelect` 而不自动停止或提交；查看/返回只切换当前详情。横向双列、窄屏堆叠、小窗口/空态/更多提示、详情正文均不得误选任务。按下任务 A 后刷新重排至任务 B，即使复用了同一行，松开仍不触发 B；刷新后 A 仍在原行的点击可完成。`fullscreen-layout.test.ts` 经停靠区从真实屏幕格点放大/关闭各一次，关闭后键盘回输入区，迷你视图的内层不会抢走外层焦点。`onStop` 在这些用例始终为零。

## T5 · 只读审批预览（R5、R6）

- [ ] 打通展开的审批入口、预览内返回及滚轮；走实现既有的打开和还原回调，压缩时保持原键盘入口。
- **验收**：`approval-panel.test.ts`、`approval-preview.test.ts`、`status-surface-approval.test.ts` 覆盖可预览的 diff/文件、无内容、折叠、仅有窄空间、更新审批请求 ID 等状态。点击可见入口只打开一次正确预览，`approve/reject` 回调为零；预览体滚轮只移动视窗，点击实际可见的返回控件仅关闭一次、不把这次点击转给下层审批。`fullscreen-layout.test.ts` 用真实 SGR 验证还原后原审批仍待处理、同一选项/输入草稿仍在、焦点复位，原点击选项及稳定窗口测试仍通过。

## T6 · 端到端回归、文档和交付（R1–R6）

- [ ] 用实际 TUI 布局和本地替身验收：屏幕上查找模型、任务、预览文字，从对应终端格送入按下和释放，而非直接调回调。检查中英文、宽屏/窄屏和双宽字符；补一组现有编辑器/补全、会话折叠、搜索、审批、Updates 点击与拖选/复制、链接、右键、普通模式的回归。不把 tmux 环境模拟当真实宿主测试。
- [ ] 同步中英文键盘/配置文档、受影响的行为注释，按 `CONVENTIONS.md` 处理用户可感知的变更说明。用可用的 Windows Terminal 或 VS Code 集成终端实点，记录宿主、尺寸、点击结果和退出恢复；如具备 tmux 再实测该宿主。宿主不可用时，明确记录未实测项和可复查步骤，不用自动结果代替实机证据。
- **自动化验收命令**（在指定目录执行，套件逐个运行）：
  - `packages/pi-tui`: `bun test --isolate test/tui-alt-screen.test.ts test/stdin-buffer.test.ts test/layout.test.ts test/mouse-components.test.ts`，然后 `bun run test`、`bun run typecheck`、`bun run build`。
  - `apps/kimi-code`: 先用 `bun test --isolate` 运行上述受影响的组件/工具/布局用例；然后 `bun run test`、`bun run typecheck`、`bun run build`。集成用例至少断言一次有效动作及对应的零误触。
  - 根目录: 对改动文件做项目格式检查，运行 `bun run check:lint`、`bun run build:docs` 和 `git diff --check`。开始前、结束后核对 `git status --short`，清理本轮临时验证产物，不改既有未提交文件，不提交或推送。
- **交付门槛**：按 R1–R6 逐条记录通过证据、命令、结果和未覆盖环境；增量失败必须处理，基线/环境问题明确区分。没有新鼠标系统钩子、全局输入监听、依赖或配置变化；不能只凭类型检查宣告点击已验证。

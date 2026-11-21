# 全屏 TUI 鼠标点击：设计

## 现有链路及盘点

`apps/kimi-code/src/tui/tui-state.ts:40` 依据已经解析的模式选用 `TuiAltScreen` 或 `TuiMainScreen`。全屏已有流程：`ProcessTerminal` → `StdinBuffer` 分帧 → `TuiAltScreen.handleViewportInput` 解析 SGR → 浮层 / 搜索与滚动控件 / `LayoutFrame` → `GutterContainer` 或 `StatusSurface` 换算坐标 → 组件的 `handleMouse`。没有接手普通按下的地方仍由全屏选择、链接与粘贴路径处理。`packages/pi-tui/src/tui-alt-screen.ts:390` 在直连终端用当前全部移动上报，在 tmux/screen/Zellij 用当前按键移动上报；本次均不改。

| 区域 | 当前实现及结论 |
| --- | --- |
| 全屏视口、输入区 | 编辑器/补全、滚动条、搜索、跳到底部已有鼠标路由；`tui-alt-screen.ts:999` 直接用松开码合成组件 `click`，通用释放 (`3m`) 会变成 `button: 'none'`；`setLayoutRoot` 更换画面但未取消已登记的按下目标。补回归，不重做视口。 |
| 会话记录、底部按钮 | `transcript-view.ts`/`transcript-container.ts`、`sticky-user-message.ts`、`thinking.ts`、`transcript-group.ts`、`markdown/mermaid-block.ts`、`chrome/footer.ts` 已有可点内容；正文和只读统计不做新动作。`chrome/gutter-container.ts:139` 换算 `x` 后没有横向边界校验，左右外边距也可能被行处理器或折叠 fallback 当成命中。 |
| 列表与表单 | `utils/mouse.ts` 已统一接焦点、稳定窗口、列表和滚轮；会话、主题、权限、供应商、插件、问题选项及各输入表单继续使用原路径。`dialogs/model-selector.ts:301` 只处理列表行，思考分段仅绘制；`dialogs/tabbed-model-selector.ts:128` 的标签会在 `press` 时换页且未查左键。 |
| 后台任务 | `dialogs/tasks-browser.ts:388` 画了标签但只把行交给鼠标；详情/小窗口提早返回不清理行坐标，空列表可能沿用上组坐标，`更多` 提示还会盖住原本可点的最后一行。数据更新时只凭行索引取实时任务。`dialogs/background-tasks-mini.ts:70` 自己裁切子组件和画提示，未按实际绘制尺寸转发点击。 |
| 状态条与审批 | `chrome/status-surface/index.ts:527` 统一按可见区域分发；Updates 和审批选项已有点击。`approval-panel.ts:409` 通过 `Ctrl+E` 打开预览，`approval-preview.ts:89` 只接键盘；`controllers/dialog-host.ts:395` 已有只读预览挂载与还原。补预览入口和返回，不新开审批提交入口。 |

表内短路径默认位于 `apps/kimi-code/src/tui/components/`（`utils/`、`controllers/` 属于 `src/tui/`）。上述是源码盘点；实际终端编码及竞态以实现阶段的测试为准。

## 方案

### 1. 保持现有输入链，修正两处只有渲染器才能完成的手势判定

在 `packages/pi-tui/src/tui-alt-screen.ts` 的 `handleMouseEvent` 与选择 fallback 的成击段做小范围修正；给 `TuiAltScreenOptions` 增加默认关闭的内部宿主选项（`strictComponentClicks`），只在 `createTUIState` 的全屏实例打开，不加用户设置。保留 `addInputListener`、终端输出模式和键盘/滚轮路径原状。理由是组件拿到的已是归一事件，既看不到原始释放码，也无法判断根视图、浮层或失焦是否使旧手势失效。按 `packages/pi-tui/UPSTREAM.md` 记录这项库补丁的原因。

- 在现有按下手势上保存按钮和命中处的可见分发上下文：屏幕格、终端行列、所属布局/浮层及位置。比较的是命中处的呈现边界，而不是整个 `LayoutFrame` 引用；重绘同一个控件不使点击失效。读取当前帧的命中索引及最上层浮层，复用 `tui.ts` 的浮层查找，不重放一次 `press` 来判定，也不在输入路径重渲染。
- 松开沿现有链路只生成零次或一次 `click`。明确释放必须与按下按钮匹配；通用释放只从同一个有效的左键按下继承 `left`，不能把孤立释放或其他按键变成左键。组件已接手和未接手（正文选择后无拖动才尝试点击）两条路径共用这项判定，不能串发。已有 OSC 8、滚动控件的专用分支及其回调顺序不改。
- `setLayoutRoot`、失焦、尺寸变化/遮挡让在途组件点击失效。对只在 `click` 才响应的控件，也清理或失效用于成击的按下记录；不能只清组件目标、再把旧松开交给新画面的点击 fallback。真实拖选、已完成的选区及已有组件的拖动语义仍依原路径；这里不新增 `capture: true`。只保留一份在途手势，完成、取消、停止后清空。

### 2. 用实际绘制的范围和业务标识命中

- 在 `apps/kimi-code/src/tui/utils/mouse.ts` 复用 `DialogMouse`、`regionAt`、`translateMouse`、`mouseDispatch`；给本次改动的行/按钮共用小型组件内校验：无修饰左键、范围能显示、同一动作标识和同一按下目标。命中表从 render 一次产出，列宽用 `visibleWidth`，行列均用半开区间；终端格到局部格只换算一次。对会换内容的控件，按下仅记录身份，成击时再核验；不能靠本次点击坐标或显示文案推断当前动作。点不中返回 `undefined`，不把整行空白、整个面板或父容器变成按钮。真正命中时才允许按现有规则取焦点或请求重绘。
- 复用 `GutterContainer.getRenderedLayout()` 的渲染快照做本文涉及的命中，拒绝左右边距、裁剪外行和与当前宽度/子项不符的旧快照；不从事件处理里重渲染一遍来猜坐标。`StatusSurface` 继续是状态条的唯一分发者；不加平行面板，也不挪动它的可见区域裁剪。老的转焦点、折叠、滚轮与正文 fallback 不另造一套。
- 局部校验缓存仅保留最近一帧可见目标和一条按下记录；空态、详情、宽度不足或无挂载不得沿用旧范围。身份示例：模型别名＋effort、供应商/任务标签 ID、任务 `taskId`、审批 `payload.id`＋具体动作。未改身份的样式更新不按全局帧号丢点击。新增行为保持在组件层；`KimiTUI` 不接手命中分发。

### 3. 三组可见控件

新增的任务/预览可点标签只在全屏显示；由现有任务控制器和 `DialogHostController` 从 `state.ui.mode` 向组件传递内部布尔值，普通模式仍画原提示。原本已有标签的模型与任务筛选不因鼠标改造换布局。

1. **模型**：`ModelSelectorComponent.renderThinkingControl` 在绘制分段时记录范围和模型别名。左右键与命中分段共用写 `thinkingOverrides` 的路径，仍由 `commitChoice`/现有会话提交回调生效。`TabbedModelSelectorComponent` 用现有 `layoutTabStrip` 范围，只在成击切换，沿现有 `bodyShift` 转发给当前选择器；切标签后、下一帧尚未绘制时不能拿旧正文坐标去点新标签的模型。非切换态不注册范围。
2. **任务**：`TasksPanelComponent.renderChrome` 改用 `layoutTabStrip` 保留 `TASKS_TABS` 范围，`cycleTab` 和点击共用切换函数；在已有提示区域呈现查看/返回动作，和 `Enter/O`、详情中的 `Esc` 共用同一个状态转换。行使用 `ListMouseRouter`，为任务调用方加可选的标识检查：`setRegions` 记录画出时的 `taskId`，按下和成击都要与仍在当前页/位置上的任务一致。同列边距、详情正文、覆盖行的 `更多` 提示不选任务。`BackgroundTasksMiniPanel` 只转发所画的子视图高度、保持外层面板键盘焦点；在已有末行画可点放大/关闭，直接用 `onAmplify`/`onCancel`，不新增任务生命周期分支。通过原有 controller 回调更新任务，不模拟按键，`S` 停止确认只走原路径。
3. **审批预览**：展开的 `ApprovalRegion` 把入口交给原有 `ApprovalPanelComponent`，只给 `findPreviewableBlock()` 非空且确实绘制出的标签注册范围，点击和 `Ctrl+E` 共用 `onOpenPreview(block)`；动作只读，不调用 `selectChoice` 或响应接口。维持状态条预算，入口放在现有提示位置；按下后更换 `payload.id` 必须取消。`ApprovalPreviewViewer` 在现有 footer 画返回动作，和 Esc 共用 `onClose`，用 `ScrollMouseRouter` 把预览体滚轮交给原有 `scrollBy`，不让它滚下面的会话。通过 `DialogHostController` 现有 `beginScreenTakeover`/`endScreenTakeover` 恢复原审批/焦点，保留选项、反馈输入及编辑器草稿。不改 `highlightLinesWindow` 的预览窗口策略。

## 不选的做法

- **系统钩子或新的全局拦截层**：不符合已确认边界；也无法正确判断不同终端、复用器、浮层和宽字符布局。完全关闭终端上报则普通 PTY 不传坐标，不能交付控件点击。
- **只在组件上接收或重放裸输入**：组件无法区分通用释放来自哪个按下，也无法验证画面是否更换；反过来，把全部组件业务和坐标写进渲染器，也会绕过已有焦点和审批规则。只在 `pi-tui` 改无法由应用表达的成击判定，其余用原有组件/控制器边界。

## 验证入口

`packages/pi-tui/test/tui-alt-screen.test.ts` 用 `VirtualTerminal` 验证实际 SGR 输入和模式写出；`apps/kimi-code/test/tui/fullscreen-layout.test.ts` 把坐标从渲染输出取出，驱动实际布局、停靠、预览/焦点及回调。组件单测增补有动作和无动作两类断言。用户文档只更新 `docs/{zh,en}/reference/keyboard.md` 及 `configuration/config-files.md` 的全屏鼠标说明，不改变配置。实现遵循 `CONVENTIONS.md`、`apps/kimi-code/DEVELOP.md`、`.agents/skills/write-tui/DESIGN.md` 和 `packages/pi-tui/DEVELOP.md`。

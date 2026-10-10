# Progress — Updates 面板鼠标交互改回「与其他折叠一致」

Spec: `specs/martian-manhunter-hawkman-stature/`　选定方案：**全部执行**

| 任务 | 状态 | 备注 |
|---|---|---|
| T0 | ✅ | 修掉工作区红灯（我上一轮把被否决的行为写成了断言） |
| T1 | ✅ | `followTail` 取代焦点耦合的滚动状态 |
| T2 | ✅ | 滚轮不再抢键盘焦点 |
| T3 | ✅ | 只接受 `click`，修掉双触发（单击无效的真 bug） |
| T4 | ✅ | `Expandable` 能力 + `setUnhandledClick` 接线 |
| T5 | ✅ | `+N done` ⇄ `−N done` 可双向切换 |
| T6 | ✅ | 文档（中英）+ changeset 修订 |
| T7 | 进行中 | 门禁已绿，正在构建部署 |

## 各项实测记录

**T0** `notify.test.ts` 由 `1 failed | 41 passed` → **42 passed**。
失败的那条正是上一轮我自己写的
`expect(h.notifyPanel.isFocused()).toBe(true)` —— 把用户已否决的行为固化成断言。

**T1** 根因是 `render()` 里 `if (!this.focused) ch.scroll = 0`（用键盘焦点当「是否跟随最新」）。
改为 `NotifyChannel.followTail`，对齐 `btw-panel.ts:257-264`。附带修正 `upsert`：
新内容只在 `followTail` 时才把视图拉到最新，否则阅读位置不被抢走。
`blur()` 不再清空 `scroll`（失焦不该丢掉读到哪）。

**T2** wheel 分支删除 `if (!this.focused) this.focus()`。
集成测（真实 alt-screen）断言 `isFocused() === false` 且 transcript `scrollTop` 不变。

**T3** 关键发现：面板同时接受 `press` 与 `click` 时，**一次真实点击会触发两次**
（alt-screen 在 press 建立候选 target、release 未移动时补发 `click`，`tui-alt-screen.ts:975-996`），
对 `+N done` 这种 toggle 就是自我抵消 —— **单击等于没点**。
改为只接受 `click`。此前的测试只发孤立的 `press`，所以漏掉了这个 bug。

**T4** 复用仓内既有折叠协议而非自造手势：`GutterContainer.setUnhandledClick`
（`notifyPanelContainer` 本来就是 `GutterContainer`）+ `Expandable`/`hasHiddenContent` 能力
（`component-capabilities.ts`）+ `kimi-tui.ts` 里 `togglePanelsRowFold()`（与
`toggleClickedFoldBlock` 并列，同一规则两个宿主）。面板只认标签条，正文点击返回
`undefined` 交给兜底 —— 因此「点击整行切换折叠」与工具卡由**同一段代码**产生。
实测：点正文 `12 行 → 2 行`（折叠成 stub），点 stub 行恢复 `12 行`。

**T5** 修掉「单向门」：展开后聚合标签原本消失，无法折回。
现改为 `+N done` ⇄ `−N done`，同一位置双向切换。
顺带修掉一处重复逻辑：`title()` 与 `stubLine()` 都在调用点重建聚合标签，
忽略了 `tabStrip()` 已经拼好的那份 —— 现已由 `tabStrip()` 独占。

## T7 门禁结果

`tsc --noEmit` exit 0 · `oxlint` 0 error · `oxfmt --check` 通过 ·
`check-locale-keys` / `check-locale-placeholders` / `check-t-call-coverage` 均 exit 0 ·
`tools/review` 0 error / 6 warning / 0 info · `check:no-comments` OK ·
**full cli 271 文件 / 4286 通过 / 4 跳过**（较改动前 4279 增加 7 条）。

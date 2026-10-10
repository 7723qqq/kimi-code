# Design — 用仓内既有折叠协议重做 Updates 面板鼠标交互

## 一、问题定位（已核实）

上一轮的滚轮实现：

```ts
if (event.type === 'wheel') {
  const delta = event.wheelDelta ?? 0;
  if (!this.focused) this.focus();   // ← 错误：滚动＝抢焦点
  this.scrollBy(delta);
  return { handled: true };
}
```

之所以要 `focus()`，是因为 `render()` 里写着：

```ts
if (!this.focused) ch.scroll = 0;    // ← 根因：用焦点模拟「跟随最新」
```

这是**用焦点当滚动状态**。正确做法是把「是否跟随最新」作为独立状态，对齐仓内的 `BtwPanelComponent`：

```ts
// btw-panel.ts
private followTail = true;
private maxScrollTop = 0;
scroll(direction: 'up' | 'down'): boolean {
  const current = this.followTail ? this.maxScrollTop : this.scrollTop;
  const next = direction === 'up' ? Math.max(0, current - 1) : Math.min(this.maxScrollTop, current + 1);
  this.scrollTop = next;
  this.followTail = next === this.maxScrollTop;   // 回到底部即恢复跟随
  return true;
}
```

## 二、仓内的折叠协议（要复用的东西）

「其他折叠」的交互由三部分组成，全部已有：

| 机制 | 位置 | 作用 |
|---|---|---|
| `GutterContainer.setUnhandledClick(handler)` | `chrome/gutter-container.ts:47` | 命中子组件但其 `handleMouse` 未处理时，把**子组件下标**交给兜底 |
| `toggleClickedFoldBlock(index)` | `kimi-tui.ts:2376` | 兜底：`isExpandable(hit) && hasHiddenContent(hit)` 才切换 `setExpanded` |
| 能力接口 `Expandable` / `HidesContent` | `utils/component-capabilities.ts:1-12` | `setExpanded` / `hasHiddenContent` / `isExpanded` |

关键事实：**`notifyPanelContainer` 已经是 `GutterContainer`**（`tui-state.ts:152`），
且 `todo-panel.ts` **已实现 `setExpanded`**，说明面板类组件本就该接这套协议。

`dispatchToChild`（`gutter-container.ts:197`）先给子组件 `handleMouse` 机会，
返回假值才走兜底 —— 这给了我一个干净的切分：

- **面板自己处理**精确命中（标签条切频道、滚轮滚动）
- **兜底处理**模糊命中（点击正文任意位置 → 切换展开）

## 三、目标行为

| 操作 | 行为 |
|---|---|
| 滚轮（指针在面板上） | 滚动当前更新；**不改键盘焦点**；向上滚停止跟随，滚回底部恢复跟随 |
| 点击标签 | 切换到该频道（`main` / `explore` / …） |
| 点击 `+N done` | 展开/收起被折叠的频道 |
| 点击面板其他任何位置 | **切换展开/折叠**（与点击工具卡一致）：已展开 → 折叠成一行 stub；stub → 展开 |
| 键盘 `Ctrl+N` | 仍然抢占键盘焦点（不变）——鼠标浏览不该走它 |

## 四、实现方案

### 4.1 `followTail` 取代焦点耦合的滚动状态

- `NotifyChannel` 增加 `followTail: boolean`（初始 `true`）。
- `render()` 不再看 `focused`：
  ```ts
  if (ch.followTail) ch.scroll = maxScroll;
  else if (ch.scroll > maxScroll) ch.scroll = maxScroll;
  ```
- `scrollBy(delta)` 按 btw 的写法：从 `followTail ? max : scroll` 起算，落点等于 `max` 时重新置 `followTail = true`；`delta` 不能移动且已在尾部时返回 `false`。
- 翻条目 / 切频道 / 切标签 → `followTail = true`（换内容就该回到最新）。
- `blur()` **不再清空** `scroll`：焦点与「读到哪」是两件事，按 Esc 不该丢掉阅读位置。

### 4.2 面板实现 `Expandable` + `HidesContent`

`NotifyPanelComponent` 增加：

```ts
setExpanded(expanded: boolean): void   // 展开＝显示正文盒；折叠＝只显示 stub
isExpanded(): boolean                  // 当前是否展开（!collapsed）
hasHiddenContent(): boolean            // 折叠态且确有内容可展开
```

现有 `collapsed` 字段正好就是「折叠 / 展开」，鼠标与 `Ctrl+N` 共用它：

- `refreshFocus` / `focus()` 目前会 `collapsed = false`。保持「聚焦即展开」的既有语义，
  但**展开不等于抢键盘焦点** —— 鼠标点击只改 `collapsed`，不调 `focus()`。
- `hasHiddenContent()` 返回 `this.collapsed && this.channels.length > 0`，
  这样兜底只在「点它能展开出东西」时才响应。

### 4.3 `handleMouse` 收窄为精确命中

```ts
handleMouse(event) {
  if (event.type === 'wheel') { …scrollBy…; return { handled: true }; }   // 不调 focus
  if (press|click && left) {
    const key = this.tabKeyAt(event.x, event.y);   // 仅标签条行
    if (key !== undefined) { …switch channel / toggle +N done…; return { handled:true, render:true }; }
    return undefined;                              // ← 交给 GutterContainer 兜底做「点击切展开」
  }
  return undefined;
}
```

要点：**点击正文不再自己处理**，而是返回 `undefined` 让 `unhandledClick` 兜底，
这样「点击整行切换折叠」的行为与 transcript 里的折叠块**由同一段代码产生**，
不会两处行为不一致。

### 4.4 接线

`tui-state.ts` 已经给 `transcriptContainer` 装了兜底（`kimi-tui.ts:431`）。
`notifyPanelContainer` 是独立的 `GutterContainer`，需要同样的注册：

```ts
notifyPanelContainer.setUnhandledClick((index) => { /* 命中即 notifyPanel */ });
```

因为该容器下只有一个子组件（`notifyPanel`），`index` 恒为 0；实现上直接调
`toggleClickedFoldBlock` 的等价逻辑（`isExpandable` + `hasHiddenContent` + `setExpanded`），
复用 `component-capabilities.ts` 的判定函数而非重写。

### 4.5 滚轮是否仍返回 `handled`

**是**，但理由与上一轮不同：不再是「拦截以防穿透」，而是「指针在面板内时，滚动就该作用于此面板」。
布局命中测试已经保证只有指针真的落在面板矩形内才会调用本方法，
所以这是正确的目标选择，不是抢别的组件的输入。

## 五、被否的方案

1. **保持现状（滚轮抢焦点）** —— 用户已明确否决；且会让后续按键被面板吞掉。
2. **滚轮改 `focus` 为「隐式聚焦但不显示焦点」** —— 仍然把两种状态绑在一起，只是更隐蔽；不改 `render()` 的根因就迟早再撞上。
3. **只让 `+N done` 可点击，正文点击不响应** —— 与「其他折叠」不一致（工具卡是点整行），用户要的正是这种一致性。
4. **给面板套 `ScrollView` 让滚轮自然生效** —— `ScrollView` 只能有一个子组件且会接管渲染裁剪，与面板自绘边框/标题的现状冲突；改用 `followTail` 更贴近仓内 `btw-panel` 的先例。
5. **新增键位翻页** —— 用户要的是鼠标一致性，不是更多键盘入口。

## 六、实测结论（已用探针验证，替代原「风险」条目）

| 验证 | 结果 | 影响 |
|---|---|---|
| `GutterContainer` 兜底收到的类型 | **`click`**（需要完整 press+release；只发 press 不触发） | 兜底可用于「点击切换折叠」 |
| 面板自己的 `handleMouse` 同时接受 `press` 和 `click` | **一次真实点击触发两次**，`+N done` 的 toggle 自我抵消（实测点击后 `isFinishedExpanded()` 仍为 `false`） | **上一轮实现的真实 bug**：我此前的测试只发孤立的 `press`，所以漏掉了 |
| 只接受 `click`（忽略 `press`） | 单击 `+N done` 正确切换 `false → true` | 修法确定 |

### 因此设计修正为

- 面板的 `handleMouse` **只处理 `click`**，不再接受 `press`。理由：alt-screen 的点击是
  「press 建立候选 target → release 时若未移动则在同坐标补发 `click`」
  （`tui-alt-screen.ts:975-996`），所以 `click` 是权威的「完成一次点击」信号；
  同时接受 `press` 会双触发。
- 兜底（`setUnhandledClick`）本身也只认 `click`，两边语义因此一致。

### 新发现的遗留缺口（需在任务里处理或在文档中记录）

`+N done` 展开后，聚合标签**消失**（被折叠的频道变成独立标签），于是**没有可见目标再点回去折叠**。
两种处理：
- (a) 展开态额外显示一个 `−N` 折叠标签，点击收回；
- (b) 让「点击面板空白处」也能收起（与 4.3 的「点击整行切换折叠」合并成同一个动作）。

推荐 (b)：它正好是用户要的「像其他折叠一样」——其他折叠也是点同一处来回切。

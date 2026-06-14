# Composer 队列/任务/待办一体化气泡 + 展开面板设计

## 目标
把当前 Composer 顶部横向的 `queue-strip` 改成一个虚线边框的聚合气泡，固定在输入框卡片的右上方。点击气泡在输入框内展开一个较大的面板，统一展示：

1. 待发送消息队列（Queue）
2. 后台任务（Tasks）
3. 待办事项（Todos）

## 范围
- 仅 Web 端（`apps/kimi-web`）。
- 仅改动 `Composer.vue`、`ConversationPane.vue` 的透传，以及对应的 i18n locale 文案。
- 不涉及现有的后台任务详情页（`TasksPane.vue`）和待办详情页（`TodoCard.vue`）的功能；展开面板复用其摘要数据，必要时提供跳转到对应 Tab 的入口。

## 改动点

### 1. 聚合气泡（Queue Bubble）
- **位置**：`.composer` 卡片内部右上角，绝对定位，与卡片内边距对齐。
- **样式**：圆角胶囊，1px dashed border（使用 `--line`），背景 `--panel`，hover 时背景微亮。
- **内容**：
  - 当 `queued.length > 0` 或 `tasks` 中存在 running 任务或 `todos` 中存在未 done 项时显示。
  - 左侧显示总数量徽标（如 `3`）；右侧最多放 3 个小色点，分别代表 queue / tasks / todos 三类活动。
- **交互**：点击切换 `queuePanelOpen` 状态。

### 2. 展开面板（Queue Panel）
- **位置**：气泡正下方、附件条（`.att-strip`）上方，宽度紧贴 `.composer` 内边距。
- **尺寸**：最大高度约 `280px`，内部整体滚动；面板背景 `--panel`，顶部圆角与 composer 一致，底部无圆角或微笑过渡无边框。
- **分区**：3 个可折叠区块，每个区块有自己的标题栏和计数徽标：

#### 2.1 Queue 区
- 列出 `queued`，每行展示文本或 `queuedImageOnly` 占位符、附件徽标、移除按钮。
- 纯文本条目可点击载入输入框（`editQueued`）。
- 若 `running`，底部保留 `Steer now` 按钮。
- 空状态显示文案“暂无队列消息”。

#### 2.2 Tasks 区
- 列出 `tasks`，每行显示状态圆点（run / done / fail）、任务名称、耗时/元信息。
- running 的任务右侧显示 Stop 按钮，触发父组件的 `cancelTask`（通过透传或 emit）。
- 点击任务行可在面板内展开最近几行 output 预览。
- 空状态显示“暂无后台任务”。

#### 2.3 Todos 区
- 列出 `todos`，每行显示状态圆点/勾选图标 + 标题。
- 只读展示，点击标题可跳转至 `todo` Tab（通过 emit `focusTodo`）。
- 空状态显示“暂无待办”。

### 3. 多消息 UI/UX
- 每行单行省略，hover 时通过 `title` 展示完整文本。
- 每个分区独立滚动，超过约 6 行显示内部滚动条（分区标题固定）。
- 标题上的计数徽章始终可见，便于快速判断哪个分区有内容。
- 操作按钮集中在每行最右侧，保持 `8px` 间距。

### 4. 数据流
- `Composer.vue` 新增 props：
  - `tasks?: TaskItem[]`
  - `todos?: TodoView[]`
- `ConversationPane.vue` 在现有 `<Composer>` 调用处新增：
  - `:tasks="tasks"`
  - `:todos="todos ?? []"`
- `Composer.vue` 新增局部状态 `const queuePanelOpen = ref(false)`。
- 新增 emit：
  - `cancelTask: [taskId: string]`
  - `focusTodo: []`

### 5. i18n 新增 key

在 `apps/kimi-web/src/i18n/locales/{zh,en}/composer.ts` 中增加：

| Key | zh | en |
|---|---|---|
| `queueBubbleTitle` | 队列 / 任务 / 待办 | Queue / Tasks / Todos |
| `queueSection` | 队列 | Queue |
| `tasksSection` | 后台任务 | Background tasks |
| `todosSection` | 待办 | Todos |
| `noQueued` | 暂无队列消息 | No queued messages |
| `noTasks` | 暂无后台任务 | No background tasks |
| `noTodos` | 暂无待办 | No todos |
| `taskOutput` | 输出 | Output |
| `stopTask` | 停止 | Stop |

## 验收标准
- [ ] 当 queue / tasks / todos 全为空时，气泡不显示。
- [ ] 气泡使用虚线边框，位于输入框卡片右上方。
- [ ] 点击气泡可展开/收起面板。
- [ ] 面板内按 Queue / Tasks / Todos 三个区块展示，每区计数徽标准确。
- [ ] 多个 queued / tasks / todos 时，面板内容可滚动，行内文本省略并 hover 展示完整内容。
- [ ] Tasks 区支持停止 running 任务；Todos 区支持点击跳转 todo Tab。
- [ ] Typecheck 与现有测试通过。

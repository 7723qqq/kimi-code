# Tasks — 全屏模式的能力覆盖与对齐

需求见 `requirements.md`（R1–R3），设计见 `design.md`。每条任务的验收断言都**在当前代码上真实失败**，
改完后必须真实通过。

依赖关系：**T1 独立先做**（唯一的实现改动）；**T2 / T3 独立可并行**（文档）；
**T4 收尾**（门禁 + changeset）。T1 必须先于 T4，因为 T4 的包级测试要包含 T1 的新用例。

全局命令（每个任务的"自测"在此基础上追加）：

```
cd apps/kimi-code && bun test --isolate test/tui/fullscreen-layout.test.ts \
  test/tui/utils/screen-takeover.test.ts test/tui/commands/tui-mode-preferences.test.ts
```

---

## T1 — 编辑器槽位的模态面板保留自己的导航键（R1）

**文件与符号**

- `apps/kimi-code/src/tui/controllers/dialog-host.ts` → `DialogHostController.mountEditorReplacement()`（:114）
- 测试加进既有 `apps/kimi-code/test/tui/fullscreen-layout.test.ts`（CONVENTIONS：优先加进既有文件）

**行为改动**

`mountEditorReplacement()` 在把面板塞进 `editorContainer` 并 `setFocus` 之前，给面板声明
`ownsViewportKeys = true`。全屏渲染器因此不再抢走 `PgUp`/`PgDn`/`Home`/`End`，
这些键到达面板自己的列表。

**验收断言**（追加到 `fullscreen-layout.test.ts`，沿用该文件已有的
`mountFullscreen` + `VirtualTerminal` 构造方式）

用例 A：全屏下，经 `DialogHostController.mountEditorReplacement` 挂载的选择器，
`PgDn` 翻自己的列表，会话记录视口不动。

```ts
const { state, vt } = await mountFullscreen();
const alt = state.ui as TuiAltScreen;
state.transcriptContainer.addChild(
  new Text(Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n'), 0, 0),
);
const controller = new DialogHostController(stubDialogHost(state), stubApproval(), stubQuestion());
const picker = new ChoicePickerComponent({
  title: 'pick',
  options: OPTIONS,
  currentValue: 'opt0',
  onSelect: () => {},
  onCancel: () => {},
});
controller.mountEditorReplacement(picker);
alt.renderNow();
await vt.waitForRender();
alt.scrollToTop();
await vt.waitForRender();
const topBefore = alt.viewportTop;

vt.sendInput('\u001B[6~');
await vt.waitForRender();

expect(selectedOption(picker)).toBe('8');   // 面板自己翻页了
expect(alt.viewportTop).toBe(topBefore);    // 视口没动
expect(
  (picker as unknown as { ownsViewportKeys?: boolean }).ownsViewportKeys,
).toBe(true);
```

用例 B：常规模式不受影响（同一个控制器、同一块面板，`PgDn` 同样翻面板的列表）。

```ts
// 常规模式下 TuiMainScreen 把键直接交给焦点组件，行为与修复前一致
expect(selectedOption(picker)).toBe('8');
```

用例 C（防收窄过度）：**没有**经过 `mountEditorReplacement` 的普通组件仍然由视口翻页。

```ts
// 直接把一个裸组件挂到 editorContainer 并聚焦（不走控制器）
// 全屏下 PgDn 仍然翻会话记录，视口行为不变
```

**失败证明**：用例 A 在修复前失败——探针实测 `viewportTop 0→3`、选择器仍在 `option 0`；
用例 B 在修复前通过（常规模式本来就是对的），修复后仍须通过。

**执行记录**

- 断言顺序按"行为优先"调整：先断行为（选择器翻到 `option 8`、视口不动），再断机制
  （`ownsViewportKeys === true`）。机制断言放在后面，是为了让修复前的失败落在真正的
  症状上，而不是落在一个标志位上。
- `ChoicePickerComponent` 用 `implements Component` 而不是 `extends`，所以
  `ownsViewportKeys` 不在它的类类型上；断言要用
  `(picker as unknown as { ownsViewportKeys?: boolean })` 读，否则 `tsc` 报 TS2339。
- `dialog-host.ts` 与 `fullscreen-layout.test.ts` 在 HEAD 上就**不是** oxfmt-clean 的
  （本轮之前的格式漂移）。本轮只保证新增的行符合 oxfmt，不夹带无关的重排。
- 失败-通过双向验证：用 `git stash push -- <file>` 撤掉实现，用例 A 变红
  （`Expected: "8" / Received: "0"`），`git stash pop` 恢复后变绿。

**依赖**：无（第一条）。

---

## T2 — `keyboard.md` 的按键归属改成实际行为（R2）

**文件与符号**

- `docs/zh/reference/keyboard.md:21`（`Updates` 面板聚焦后的键位段）
- `docs/en/reference/keyboard.md:21`（同一段）

**行为改动**

删掉"全屏模式下这两个键用于翻动会话记录"这句与实现不符的补充，改成：
`PgUp`/`PgDn` 在两种模式下都切换当前频道的更新；全屏模式下翻动会话记录用鼠标滚轮，
或 `Ctrl-Up`/`Ctrl-Down` 在提问之间跳转。

**验收断言**

文档门禁：`bun run check:locale-keys` / `check:locale-placeholders` 不涉及本文件；
人工核对：中英文两段的**事实**一致，且与 `custom-editor.ts:630-638`、
`tui-alt-screen.ts:870-877` 的实现一致。

**失败证明**：修复前 `docs/zh/reference/keyboard.md:21` 写着"全屏模式下这两个键用于翻动会话记录"，
与 `custom-editor.ts:630-638`（编辑器把 `PgUp` 转交给状态条）矛盾。

**依赖**：T1（描述的是 T1 之后的行为）。

---

## T3 — `config-files.md` 的 `tui_mode` 描述反映覆盖范围（R3）

**文件与符号**

- `docs/zh/configuration/config-files.md:641`
- `docs/en/configuration/config-files.md:641`

**行为改动**

`tui_mode` 的一行说明改成覆盖范围与生效条件：

- `regular`：渲染进终端滚动缓冲区；
- `fullscreen`（实验性）：改用备用屏幕，会话记录变成应用内可滚动区，额外提供应用内鼠标选区复制、
  `Ctrl-Shift-F` 会话记录搜索、`Ctrl-Up`/`Ctrl-Down` 提问跳转；
- 两种模式的面板、对话框与键位一致；
- 切换后需重启 Kimi Code 生效。

**验收断言**

人工核对：说明里的每一句都能在 `requirements.md` 的矩阵里找到对应行；
`grep -n "tui_mode" docs/{zh,en}/configuration/config-files.md` 命中的表格行与
`config.ts:309-320` 解析的取值一致（`regular` / `fullscreen`）。

**失败证明**：修复前该行只说"部分组件支持鼠标交互"，既没写覆盖范围也没写重启要求。

**依赖**：T1（描述的是 T1 之后的行为）。

---

## T5 — 列表对话框的鼠标交互（R4）

**文件与符号**

- 新增 `apps/kimi-code/src/tui/utils/list-mouse.ts`（`ListMouseRouter`、`ListCursor`、
  `searchableListCursor`、`listMouseDispatch`）
- 新增 `apps/kimi-code/test/helpers/mouse.ts`（共享的鼠标事件构造器 + 稳定窗口）
- 接入的对话框（各加一个 `ListMouseRouter`、在 render 里记录行矩形、转交 `handleMouse`）：
  `choice-picker`（改为共用路由）、`model-selector`、`tabbed-model-selector`、
  `session-picker`、`undo-selector`、`experiments-selector`、`model-switch-confirm-dialog`、
  `cache-hint-dialog`、`goal-queue-manager`、`provider-manager`、
  `start-permission-prompt`（含三个子类）、`trust-prompt`、`tasks-browser`
- 只滚不选的对话框：`help-panel` 走新增的 `ScrollMouseRouter`
- 形状不是"一列行"的面板走同一套原语，不另写模式分支：
  - `question-dialog`：渲染期记录三类矩形（选项 / 标签 / 提交动作），命中后按键盘语义处理
  - `plugins-selector`：行点击只移动 `selectedIndex`，破坏性动作不映射到指针
  - `tabbed-model-selector`：标签条按列命中；其余行减去 `bodyShift` 转发给当前标签的内层选择器
- 标签条几何：`utils/tab-strip.ts` 增加 `layoutTabStrip()`（返回 `{text, spans}`），
  `renderTabStrip()` 退化为取 `.text`，调用点不变
- 共享的命中判断：`utils/list-mouse.ts` 增加 `RowRegion` 与 `regionAt()`，
  `ListRowRegion` 继承前者，`ListMouseRouter.rowIndexAt` 改用它
- 测试加进各对话框**既有**的测试文件，另在 `fullscreen-layout.test.ts` 加一条端到端用例

**行为改动**

全屏模式下，列表对话框的指针悬停高亮该行、滚轮翻页、点击选中该行；未持焦时第一次
点击只取焦点。

**验收断言**

每个对话框的既有测试文件加一条：构造面板 → 渲染出每一行 → 按行号发 `move`/`press`/
`release`/`click` → 断言选中结果（选择器/模型/会话/撤销/实验/确认/缓存）或状态变化
（目标队列进入重排标记、供应商管理高亮该行）。

`fullscreen-layout.test.ts` 的端到端用例发**真实终端 SGR 序列**：

```ts
const rows = vt.getViewport().map(stripAnsi);
const row = rows.findIndex((line) => line.includes('option 5'));
const column = rows[row]!.indexOf('option 5');
vt.sendInput(`[<0;${column + 1};${row + 1}M`);
vt.sendInput(`[<0;${column + 1};${row + 1}m`);
await vt.waitForRender();
expect(picked).toEqual(['opt5']);
```

**失败证明**：端到端用例在接入前红——探针实测模型选择器点击后 `picked` 为空
（面板没有 `handleMouse`，事件被渲染器吞掉）。

**执行记录**

- `ListCursor` 一开始用属性（`items`/`selectedIndex`）表达，自带列表的供应商管理器
  在对象字面量里读不到组件的 `this`（`this` 指向字面量本身）。改成方法式接口后，
  箭头函数捕获组件的 `this`，两个家族都成立。
- `ListMouseRouter` 要返回 `TuiMouseDispatchResult`（`Container.handleMouse` 的签名
  要求 `target` 元数据），而 `ChoicePickerComponent` 实现的是 `Component`
  （`TuiMouseEventResult` 即可）。两条路都留得住：前者用 `listMouseDispatch()` 包一层，
  后者直接返回。
- `searchableListCursor` 收列表的**getter**而不是列表本身：目标队列会在换页时重建
  列表，路由器必须跟着走。
- 任务浏览器是双栏（列表 + 详情），行矩形因此多带一段**列区间**：点在详情栏不算
  命中任务行。
- 帮助面板只会滚、不用选，给它单独一条 `ScrollMouseRouter`：滚轮 3 行一档，到底不动。
  之前全屏下滚轮会穿透去滚会话记录。
- 信任提示的选项在面板**底部**（分页披露正文之下），行矩形的起点要按页脚的实际
  高度算，不能按渲染顺序猜。

**依赖**：无（与 T1 独立）。

---

## T4 — 收尾门禁与 changeset

**动作**

1. `cd apps/kimi-code && bun test --isolate test/tui/fullscreen-layout.test.ts test/tui/utils/screen-takeover.test.ts test/tui/commands/tui-mode-preferences.test.ts`
2. `cd apps/kimi-code && bun run test`（R1 动了所有对话框共用的挂载路径，要跑整包）
3. `bun run lint`
4. `bun run check:no-comments`
5. `bun scripts/check-t-call-coverage.mjs`（本轮不新增文案，作为证据）
6. 按 `.agents/skills/gen-changesets` 写一条 `.changeset/` 说明：
   用户可感知的行为是"全屏模式下对话框的 `PgUp`/`PgDn` 翻页恢复生效"。
   等级按该 skill 的规则取 `patch`（缺陷修复）；**不自行决定 `major`**。

**验收断言**：以上命令退出码为 0。没有可失败的测试断言——这是门禁，不是行为。

**执行记录（2026-10）**

| 门禁 | 结果 |
| --- | --- |
| `bun test --isolate`（三个目标文件） | 32 pass / 0 fail |
| `cd apps/kimi-code && bun run test` | 4903 pass / 22 skip / 0 fail（301 个文件） |
| `cd apps/kimi-code && bun run typecheck` | 通过 |
| `bun run lint` | 0 errors（warning 是仓库既有基线） |
| `bun run check:no-comments` | OK（2118 files） |
| `bun scripts/check-t-call-coverage.mjs` | 通过（2137 files / 2498 keys） |
| `cd docs && bun run build` | build complete（markdown 无破坏） |

changeset 落在 `.changeset/fullscreen-dialog-paging.md`（`patch`）与
`.changeset/fullscreen-dialog-mouse.md`（`patch`）。

T5（鼠标交互）落地后的门禁复跑：typecheck 通过；整包 `bun run test` **4912 pass /
22 skip / 0 fail**（301 个文件）；`bun run lint` 0 errors；locale / prose /
no-comments 四个门禁全绿；`docs` 站点 build 通过。

第二轮（问题对话框、插件面板、标签条几何）落地后的复跑：范围测试
（`test/tui/components/dialogs` + `test/tui/utils` + `fullscreen-layout` +
`tasks-browser`）**707 pass / 0 fail**（53 个文件）；整包 **4931 pass / 22 skip /
0 fail**（302 个文件）；typecheck 通过；`bun run lint` 0 errors。

该轮同时补上一个真实缺口：`ChoicePickerComponent` 本来就会用 `PgUp`/`PgDn` 翻自己的
列表（`SearchableList`），却没有声明 `ownsViewportKeys`，全屏下这两个键被 transcript
视口吃掉；补上声明后才与 `help-panel` / `trust-prompt` / `tasks-browser` 一致。

第三轮把"设置界面"这一类核完：`settings-selector`、`permission-selector`、
`theme-selector`、`locale-selector` 与各 `*-preference-selector` 都是
`ChoicePickerComponent` 子类，第一轮改基类后已一并获得鼠标能力。唯一独立实现的
`effort-selector`（横排分段）单独接上：复用 `regionAt` 的列区间，点击某段 = 选中并
提交（与 Enter 一致），滚轮一格 = 左右一步。

最终门禁：整包 **4933 pass / 22 skip / 0 fail**（302 个文件、23014 个断言）；
typecheck 通过；`bun run lint` 0 errors；`check:no-comments` / `check:t-coverage` /
`check:locale-keys` / `check:locale-placeholders` / `check:no-hardcoded-prose` /
`check:status-surface-i18n` 全绿；`cd docs && bun run build` 通过。

第四轮收掉最后一批表单面板（此前全屏下点不动）。判据是"既不实现 `handleMouse`、
也不继承已实现的基类、也没有 `addChild` 可转发"——按此复核后确认 `approval-panel`
与 `notify-panel` 走 `DockSection.handlePartMouse`、`background-tasks-mini` 靠
`addChild(inner)` 继承 `tasks-browser` 的能力，均**不是**缺口。真正的缺口按形状分三类：

| 形状 | 面板 | 接法 |
| --- | --- | --- |
| 字段列表 | `astron-settings`、`coding-plan-config` | `ListMouseRouter`；astron 点击 = Enter 语义（开关翻转 / 数字进入编辑），coding-plan 点击只选中 |
| 单/双输入框 | `api-key-input-dialog`、`feedback-input-dialog`、`custom-registry-import` | 新增 `utils/form-mouse.ts` 的 `inputPressAt()`：把事件平移进 `Input` 自己的坐标再转发 |
| 大表单 | `provider-form-dialog` | 渲染期按序 `add(line, tag)` 记录 `field` / `input` / `row` / `save` 四类矩形；Save 只选中，提交仍要 Enter |

`Input.handleMouse` 只回答 `press` 且要求 `y === 0`，因此 helper 把 click 也按 press
转发（重复定位光标无副作用）；掩码字段只承诺"选中字段"，不承诺光标精确落在密文位置。

第四轮门禁：范围测试（`test/tui/components/dialogs` + `test/tui/utils` +
`astron-settings` + `fullscreen-layout`）**689 pass / 0 fail**（54 个文件）；整包
**4945 pass / 22 skip / 0 fail**（303 个文件、23025 个断言）；typecheck 通过；
`bun run lint` 0 errors。

**依赖**：T1–T3 全部完成。

# pi-tui fork 深度调研：oh-my-pi vs 我们

> 调研对象
>
> - **我们的 fork**：`packages/pi-tui`（`@moonshot-ai/pi-tui` 0.80.2，仓库内）
> - **oh-my-pi 的 fork**：`oh-my-pi/packages/tui`（`@oh-my-pi/pi-tui` 16.1.16，本地工作区）
> - 报告路径中的行号引用 **oh-my-pi** 时均指 `oh-my-pi/packages/tui`，引用 **我们** 时均指 `packages/pi-tui`。

---

## 0. 一句话结论

我们的 fork 基本是**上游 0.80.2 的原样 vendor**（仅 2 个提交：vendor + integrate），几乎没有本地修改；而 oh-my-pi 是把 pi-tui 在生产环境里**重负载跑了 6 个月、迭代了 1500+ 次提交、发过 ~150 个版本**的深度演化版本。

因此，"oh-my-pi 改了什么"几乎等价于"**社区在真实 CLI Agent 场景下踩过的所有坑 + 性能优化 + 鲁棒性加固**"，参考价值极高。最值得借鉴的不是某一个功能，而是它把 pi-tui 从一个"差分渲染 TUI 库"升级成一个"**面向流式 Agent 会话、保护 native scrollback、按终端能力自适应、可被模糊测试验证**"的运行时。

---

## 1. 背景与血缘

两者**同源**，均派生自上游 `@mariozechner/pi-tui`（即 `badlogic` / `pi-mono` 仓库，作者 Mario Zechner）。

- 我们的包 vendored 自 `@earendil-works/pi-tui` 0.80.2（这是 badlogic 上游的一个中间 fork），版本停在 0.80.2。
- oh-my-pi（作者 Can Boluk，仓库 `can1357/oh-my-pi`）是另一条更激进的 fork，已演进到主版本 **16**。它的 CHANGELOG 里大量出现 `ports pi-mono <hash>`、`badlogic/pi-mono#nnn`，说明它仍在持续 cherry-pick 上游，但核心已经重写。

**体量对比**

| 维度 | 我们 (`packages/pi-tui`) | oh-my-pi (`packages/tui`) |
|---|---|---|
| 包名 / 版本 | `@moonshot-ai/pi-tui` 0.80.2 | `@oh-my-pi/pi-tui` 16.1.16 |
| 触及本包的提交数 | 2（vendor + integrate） | **1562** |
| src 文件数 | 28 | 35 |
| src LOC | 12,118 | 21,065（+74%） |
| 测试文件数 | 27 | 70（+159%） |
| 测试 LOC | 13,475 | 28,678（+113%） |
| benchmark | 无 | 6 个 |
| CHANGELOG | 无 | 1775 行 / 152 个版本条目 |
| 运行时 | Node `>=22.19`，`node --test` | Bun `>=1.3.14`，`bun test` |
| 构建 | `tsdown` 出 `dist/` | **无 bundler**，直接 ship `src/*.ts` |
| 关键外部依赖 | `get-east-asian-width`、`marked` | `marked`、`lru-cache`、`@oh-my-pi/pi-natives`(Rust NAPI)、`@oh-my-pi/pi-utils` |

> 重要认知：oh-my-pi 把包名也改了（`packages/tui`，`@oh-my-pi/pi-tui`），并深度依赖 Bun + Rust native。**不能整体替换**，只能按模块 cherry-pick。

---

## 2. 总体差异地图

### 2.1 oh-my-pi 新增的模块（我们没有）

| 模块 | 作用 | 详见 |
|---|---|---|
| `src/terminal-capabilities.ts` (1049 行) | 终端能力探测、图像协议编码、`renderImage`、`TERMINAL` 单例 | §4, §6 |
| `src/kitty-graphics.ts` | Kitty Unicode 占位符图像 | §6 |
| `src/latex-to-unicode.ts` (1994 行) + `src/latex-block.ts` (461 行) | LaTeX 数学 → Unicode/ANSI + 堆叠分式 | §7 |
| `src/bracketed-paste.ts` | bracketed paste 解析 + tmux 重编码解码 | §5 |
| `src/mouse.ts` | SGR 鼠标报告解析 | §5 |
| `src/deccara.ts` | Kitty 矩形 SGR 背景填充优化器 | §5 |
| `src/ttyid.ts` | 稳定 TTY 标识（`ttyname`/mux/env） | §5 |
| `src/loop-watchdog.ts` | 事件循环卡顿探针 | §5 |
| `src/symbols.ts` | 集中管理 box-drawing / spinner 等符号主题 | §7 |
| `src/components/scroll-view.ts` | 固定高度视口 + 滚动条 | §8 |
| `src/components/tab-bar.ts` | 水平 Tab 栏 | §8 |
| `bench/*` | 解析/布局/key/图像等微基准 | §9 |

### 2.2 我们有、但 oh-my-pi 删/搬的模块

| 我们的文件 | oh-my-pi 处置 | 现在在哪 | 我们的取舍建议 |
|---|---|---|---|
| `native-modifiers.ts` + `native/`（darwin/win32 C 预编译） | **删除** | Kitty 协议修饰键 bitmask，在 Rust `crates/pi-natives/src/keys.rs` | 若需原生修饰键轮询就保留；否则接受删除（Kitty/CSI-u 已带修饰键） |
| `undo-stack.ts`（泛型 `UndoStack<S>`） | **内联** | editor/input 内的私有数组 + `structuredClone`，cap 100 + 合并 | 可跟随删除，独立类已无必要 |
| `word-navigation.ts` | **替换并内联** | `utils.ts` 的 `moveWordLeft/Right`、`getWordNavKind`（v13.7.5） | 采纳其归并方式 |
| `terminal-colors.ts`（OSC 11 / Mode 2031） | **折叠 + native** | `terminal.ts` 的 `TerminalAppearance` + Rust `appearance.rs`（`MacAppearanceObserver`） | 采纳其折叠（更鲁棒，且本就该在 terminal 上） |
| `terminal-image.ts` | **迁移并大幅扩展** | `terminal-capabilities.ts` + `kitty-graphics.ts` + native `sixel.rs`（v11.0.0） | 概念上采纳，按需摘特性 |

---

## 3. 核心差异渲染引擎（**最重要**）

`src/tui.ts`：我们 1714 行，oh-my-pi **3695 行**。差距几乎全在渲染核心。我们的模型是经典的"上一帧 diff + viewport 跟踪 + 退化为破坏性整帧重绘"；oh-my-pi 则围绕"**追加式 native scrollback 契约**"重写了引擎。架构文档见 `oh-my-pi/docs/tui-core-renderer.md`、`tui-runtime-internals.md`。

### 3.1 我们（baseline）

`doRender`（`tui.ts:1254-1620`）把整棵树渲染成 `newLines`，合成 overlay，再和 `previousLines` 做 diff 找 `firstChanged..lastChanged`；通过 `previousViewportTop`/`maxLinesRendered` 间接跟踪滚动；在**宽度变化、高度变化、内容收缩、changed 区越过 viewport、图像过高**等情况下退化为 `fullRender`（ED2 + home + ED3，`tui.ts:1284-1325`）——这会**清掉 scrollback**。超宽行直接抛错。`?2026` 同步输出**硬编码、无门控**。节流 16ms（~60fps）。

### 3.2 oh-my-pi 的核心改造

**① 追加式 native scrollback 账本（ledger）**

引擎维护一个不可变账本（`tui.ts:995-1028`）：

- `committedRows`（C）：已经物理滚入历史的行
- `windowTopRow`（W）：当前帧 grid 第 0 行对应的内容行
- 两个审计标记 `auditRows ≤ durableRows`，把 C 切成三个区：**byte-stable-audited / durable-exempt / forced-overflow**

组件通过 `NativeScrollbackLiveRegion`（`tui.ts:220-224`）上报一个"接缝（seam）"，含两个嵌套端点：byte-stable B（`commitSafeEnd`）与 durable D（`snapshotSafeEnd`）。

> **关键设计转变**：接缝不再"决定能不能提交"，只"决定提交后归类到哪个审计区"。**追加式提交地板 = `windowTop`**——任何滚出窗口的行一定会进历史，绝不会"既没提交、也没绘制"（CHANGELOG 16.1.10 修复的正是流式输出在 barrier 下方溢出后"人间蒸发"的 bug）。

**② 范围感知的 committed-prefix 审计**

`#auditCommittedPrefix`（`tui.ts:2831-2851`）每帧校验历史行是否被组件重新排版：

- 对新变成 permanent 的 forced-overflow 行做**完整硬扫描**
- 对尾部做 SGR 剥离采样（最近 24 行里 ≤8 行非空）
- 中间 durable 区 `[auditRows, durableRows)` **豁免**——这样流式表格重新对齐列时不会喷出重复快照
- 发现插入/删除时，在第一个移动的行**重新锚定 C 并重新提交**——**"宁可重复，绝不丢失"**

这是一个非常微妙、踩过大量坑才沉淀出来的洞察。

**③ 四种发射形态（emitter）**

`#doRender`（`tui.ts:2465-2822`）计算 `W=max(C, L−height)`、`chunkTo=W`，再发射四种字节形态之一：

- `#emitFullPaint`：仅用于用户手势
- `#emitUpdate` 三种子形态：scroll-append（只发 chunk 行）、in-window diff（相对移动 + 变化区间）、seam rewrite（chunk + 整窗）
- **update 路径永不发 ED2/ED3、永不 absolute home**

### 3.3 native scrollback 保护

- **ED3 被收敛到唯一一处**（`#emitFullPaint({clearScrollback:true})`，`tui.ts:3196`），仅用户手势（会话替换/分支/resume、非 mux 下 resize、`resetDisplay`）可达。首帧用 kitty ED22 保留进入前的 shell 屏幕。删除了旧的 `PI_TUI_ED3_SAFE`/`PI_CLEAR_ON_SHRINK`/`PI_TUI_DEBUG` 开关。
- **多路复用感知**：`isMultiplexerSession()`（`tui.ts:389-401`）识别 `TMUX`/`STY`/`ZELLIJ`/`CMUX_*`，并带 `TERM=tmux*/screen*` 兜底（`sudo`/`su`/`ssh` 剥了环境也能识别）。mux 下 resize 走 50ms 防抖，**绝不 ED3**——pane 历史保留旧 wrap。
- **resize viewport defer（"transcript flash" 修复）**：非 mux 拖拽时，每次 SIGWINCH 只通过 `#renderResizeViewport`（`tui.ts:3280`）画视口，借用 alternate screen 让宽度重排碎片不进 scrollback；权威 ED3 重排在 120ms 静默窗口后一次性触发。拖拽中普通渲染**留在 fast path**（修复 16.0.11 中"还在动画的 tool block 闪一下又消失"）。
- **Warp alternate-screen 反馈回路**、`ConPTY settle`（Windows Terminal 150ms 合并窗口）等终端特判。

### 3.4 性能优化

| 优化 | 机制 | 收益 | 可移植性 |
|---|---|---|---|
| **SGR 合并** | `coalesceAdjacentSgr`（`tui.ts:725-789`）把字节相邻的 SGR 合并成一个 `CSI … m`；16 参数上限（防 xterm.js 32 参数截断）；跨不完整扩展色不合并；`PI_NO_SGR_COALESCE` 兜底 | 每帧 SGR 序列 **-30~40%** | **高价值 / 低 effort**（纯函数，可直接落到我们的 emit 路径） |
| **同步输出门控** | `?2026` 按终端能力开关（`shouldEnableSynchronizedOutputByDefault`），`PI_NO_SYNC_OUTPUT`/`PI_FORCE_SYNC_OUTPUT` 覆盖，运行时 DECRQM 对账 | 避免在 mux/坏终端上闪烁 | 中价值 / 中 effort（需能力探测器） |
| **组件级渲染** | `requestComponentRender`（`tui.ts:1887`）只重渲请求的子树根，复用其它根的行+接缝 | spinner/光标闪烁不再整树重渲 | 高价值 / 高 effort（依赖 stable-prefix 帧模型） |
| **tight layout** | `setTuiTight`/`getPaddingX` 去掉 1 格横向 padding | 更紧凑 | 低-中价值 / 低 effort |
| 节流 | 降到 ~30fps + `RenderScheduler` 抽象 | — | — |

### 3.5 Overlay 系统

- 我们：focus 模型更丰富（`OverlayHandle.focus/unfocus/isFocused`、`nonCapturing`、`overlayFocusRestore` 状态机）；无 `fullscreen`。
- oh-my-pi：overlay **只合成进 window slice**，且可见时**冻结提交**（`tui.ts:2346, 2726`）——overlay 像素永不进 scrollback，关闭无需破坏性重建。新增 `OverlayOptions.fullscreen`：最上层 fullscreen overlay 借用 alternate buffer。`maxHeight` 默认夹到可用行。

> 注意：我们的 overlay focus 恢复机比 oh-my-pi 更细；可反过来保留我们的，借鉴它的 `fullscreen` + commit-freeze。

### 3.6 渲染模糊测试（最值得参考的"合约定义"）

`render-stress-{harness,oracles,reducer,scheduler,subprocess}.ts` + `virtual-terminal.ts`：把**真实发出的 ANSI 字节**喂给 ghostty-web VT，跑随机操作序列与终端尺寸，由一个**独立的 shadow commit ledger** 校验（`scrollback == frame[0..C)`）。带 reducer + subprocess 回放以最小化失败 seed。这是**任何移植的回归网**，也是引擎行为的权威合约。

---

## 4. 终端能力协商

oh-my-pi 把"启动时探测终端能力"做成了一套严谨的协议（文档：我们也有 OSC 11 / `?2026` / bracketed paste / kitty 查询，但差异在**门控、探测纪律、headless 安全**）。

### 4.1 统一 DA1 哨兵探测 FIFO

oh-my-pi 把所有启动探测（kitty keyboard、OSC 11 背景、DECRQM 私有模式、OSC 99 通知）串行到一个 `Da1SentinelOwner[]` 队列（`terminal.ts:360-365, 752-794`）：每个探测发完查询紧跟一个 `CSI c`（DA1）。终端按序处理，**哪个回复先到就 resolve 哪个探测**——保证：(a) 在忽略某探测的终端上**永不死等**；(b) 探测字节**不会漏进编辑器**。OSC 11 也走这套（Neovim / bat / fish / terminal-colorsaurus 同款技巧）。证据：`kitty-keyboard-da1-ordering.test.ts`（DA1-before-kitty 排序，`#2042`）。

### 4.2 DECRQM 私有模式探测

通过 `CSI ? mode $ p` + DA1 哨兵探测 `?2026`(sync)、`?2048`(in-band resize)、`?2031`(appearance)、xterm `?1010/?1011`(scroll-to-bottom)（`terminal.ts:1046-1079`）：

- 开 sync、启用 DEC 2048 in-band resize（顺带推导 cell 像素尺寸）
- 确认 Mode 2031 push 后**停掉 OSC 11 轮询**
- 关掉 xterm scroll-to-bottom，避免编辑器打字把"正在滚动的阅读者"拽到尾部（`#2732`）

**我们是无条件发 `?2026`/`?2031`，从不探测 2048。**

### 4.3 静态能力表 + 环境覆盖

`terminal-capabilities.ts` 提供 `shouldEnableSynchronizedOutputByDefault`（`:187-220`）：用户覆盖 → `TERM_FEATURES` 的 `Sy` token（可穿透 SSH/mux）→ `WT_SESSION` → 已知直连终端 → mux 默认关。另有 `shouldEnableHyperlinksByDefault`（tmux ≥3.4 才开 OSC 8）、`TERMINAL_ID` 检测、可变的 `TERMINAL` 单例集中管理图像/通知协议。

### 4.4 防闪烁

- **同步输出按能力开关**：运行时 DECRQM 结果可在 mux/foot/contour/mintty 上**打开**它；环境开关可在 2026 有问题的终端上**关掉**它。
- **Headless 测试模式**：`#headless = isTerminalHeadless()`（`terminal.ts:410, 470-471`）为真时 `start()` 早返回、`#safeWrite` 空操作——**即使 `process.stdout.isTTY` 为真**，也不进 raw mode、不探测、不挂 SIGWINCH、不写 teardown。我们的等价判断只看 `!isTTY`，所以在交互式终端跑测试会**往开发者屏幕喷帧/探测**。证据：`process-terminal-headless.test.ts`。
- **ConPTY 写分块**：`chunkForConPTY`（`terminal.ts:62-115`，16 KiB、按换行对齐）+ `isConPTYHosted`（覆盖 WSL），避免 Windows Terminal 大 paint 卡视口；`ensureWindowsConsoleUtf8` FFI 每次写前重申 `CP_UTF8`，杀子进程导致的乱码。

---

## 5. 输入 / 键鼠 / 粘贴 / Watchdog

oh-my-pi 修了一堆**我们很可能还没修的输入 bug**。

### 5.1 输入鲁棒性（我们很可能仍有的 bug）

| Bug | oh-my-pi 修法 | 我们的状况 | 可移植性 |
|---|---|---|---|
| tmux 下 bracketed paste 漏 `[27;5;106~` 转义尾巴 | `bracketed-paste.ts` `decodeReencodedPasteControls`（`:37-41`）同时解 tmux `extended-keys-format` 的 csi-u 和 xterm 两种变体 | 我们只解 csi-u，且只在 `editor.ts:1149-1154` 内联；**xterm 变体仍漏** | **高价值 / 低 effort**（扩一个正则分支） |
| 鼠标/转义序列尾巴被当文本（如 `[<35;8;16M`、`[B` 漏进设置搜索） | `stdin-buffer.ts` 把"无歧义的部分序列"（SGR 鼠标前缀、kitty 激活时的悬挂转义）hold 住，超时后到 `PARTIAL_HOLD_MAX_MS=150` 再 flush，并加 `setTimeout(0)` 防事件循环卡顿撕序列 | 我们的 buffer **完全没有** | **高价值 / 中 effort**（集中在 `stdin-buffer.ts`） |
| 粘贴结束符丢失导致挂起/内存膨胀 | 粘贴 inactivity watchdog（1000ms）+ 64 MiB 字节上限 + `#abortPaste` 恢复（`stdin-buffer.ts:471-501`） | **无** | 同上 |
| Kitty enable-level 协商错误 | 根据上报 flags 选 `>1u`/`>7u`，任何 `CSI ?u` 回复即视为支持；DA1 抢跑启用 modifyOtherKeys 后，kitty 回复到达再**撤销**，避免 stacked-mode 回归（`#3259`） | 我们无条件开 level 7，协商 buffer 是自写的 | 中价值 / 中 effort |
| VS Code 集成终端小键盘被当导航键 | `keys.ts` `decodeKittyKeypadText`/`matchesKeypadKey`（`:517-529`）把数字键区 codepoint 映成数字/运算符 | **无** | 中价值 / 低 effort |

### 5.2 其他输入模块

- **`mouse.ts`**：`parseSgrMouse`（`:34-45`）解 button/col/row/release/wheel/motion/leftClick，门控到 fullscreen overlay。**我们没有对应模块。**
- **`ttyid.ts`**：`getTerminalId`（`:41-83`）通过 `bun:ffi` 调 `ttyname(3)`，并回退到 mux/env（`ZELLIJ_PANE_ID`/`TMUX_PANE`/`KITTY_WINDOW_ID`/`WT_SESSION`）。用于 per-tty 会话命名/面包屑。**依赖 FFI。**
- **`deccara.ts`**：`planDeccaraFills`（`:240-313`）把纯色面板尾部背景填充空格替换成 Kitty 矩形 SGR `CSI …$r` 批处理，kitty-only、mux 关、`PI_NO_DECCARA` 兜底、`bun test` 下强制关。**med/high effort，且耦合渲染器。**
- **`loop-watchdog.ts`**：常驻事件循环卡顿探针（250ms 间隔/阈值），每次阻塞打一条 `ui.loop-blocked`，带当前 phase；`unref`、generation 防护、`stop()` 撤定时器。注意 `docs/advisor-watchdog.md` 的"watchdog"是另一个不相关的 advisor 功能（双评审模型），不是这个探针。
- **崩溃安全 emergency restore**：`emergencyTerminalRestore`（`terminal.ts:236-280`）按跟踪的 alt-screen 状态门控 `?1049l`，防止 Windows 上"死帧时 shell 提示符残留"。**高价值 / 低 effort。**

---

## 6. 图像与图形协议

**结论：oh-my-pi 是整体重写，不是打补丁。** `terminal-image.ts` 被删，逻辑拆到 `terminal-capabilities.ts`（能力 + 协议编码 + `renderImage`）和 `kitty-graphics.ts`（Unicode 占位符），`components/image.ts` 从 126 → 444 行。

| 能力 | oh-my-pi | 我们 | 可移植性 |
|---|---|---|---|
| **Sixel** | `ImageProtocol.Sixel`、`encodeSixel`（经 native `@oh-my-pi/pi-natives`）、Windows-Terminal-preview 探测 | 无 | 中价值 / 高 effort（依赖 native sixel 编码器） |
| **Kitty Unicode 占位符** | `kitty-graphics.ts` 把图像渲染成真实文本 cell（`U+10EEEE` + 行/列组合变音符号，297 项表），能扛横向切片/重排/重叠；超 297 cell 或不支持时回退直接放置 | 用 `a=p` 光标定位 | **高价值 / 中 effort**（自包含、无 native 依赖，变音表可移植） |
| **transmit-once + 稳定 id** | `a=t` 只发一次 base64，`a=p` 重放小序列；`imageKey` 把逻辑图映到稳定 id，重绘**替换**而非堆叠 | 每帧重传 | 高价值 / 中 effort |
| **ImageBudget** | `ImageBudget`（默认上限 8）只保留最近 N 张，旧的降级为文本，经 `d=I` purge + 强制整帧重绘；含 resize "stable pass" 重放 | 无 | 高价值 / 中-高 effort（需渲染器配合 beginPass/endPass/purge） |
| **缓存失效** | 缓存键含宽度 **+** 协议、cell px、占位符标志、抑制态 | 只按宽度 | 中价值 / 低 effort |

`terminal-colors.ts`（OSC 背景查询/scheme）在 oh-my-pi 没有等价物——它用 `Bun.color` 量化颜色。

---

## 7. Markdown / LaTeX / 文本

### 7.1 Markdown（大改：858 → 1823 行，全是真 bug 修复）

- **HTML 标签处理（我们很可能仍有此 bug）**：我们把 block/inline `html` token 当原始文本（`markdown.ts:470-475, 569-574`），`<br>`/`<li>`/`<span>`/`<text>` 会原样显示。oh-my-pi 的 `normalizeHtmlForTerminal`（`:127-227`）转换：`<br>`→换行、`<p>`/`<li>`→带嵌套 `<ol>`/`<ul>` 自动编号的换行、`<span>`/`<text>` 剥标签保内容，并解码实体（`&amp;`、`&#x1F600;`）。**高价值 / 低-中 effort，纯函数可直落。**
- **数学/LaTeX 集成**：四个 Marked 扩展在 emphasis/link 规则破坏前**隔离**数学（inline `math`、own-line `$$`/`\[`、bare-env、`soleDisplayMath` 提升），经 `latexToUnicode`/`latexToBlock` 渲染。
- **Mermaid ASCII**：```` ```mermaid ```` 经主题 hook `resolveMermaidAscii` 渲染成 ASCII 并裁宽；我们当普通代码块。**中价值 / 低 effort。**
- **增量流式 lex**：`#lexTokens`/`#freezeStablePrefix`（`:788-850`）在追加式增长时只重 lex 追加的尾部（在 `\n\n` 边界冻结），把流式揭示从 **O(N²)→O(N)**。`markdown-incremental-lex.test.ts` 断言每一步与冷全量 lex **字节一致**。**高价值 / 中 effort。**
- **L2 渲染缓存**：模块级 `LRUCache`，按 text/width/theme/能力探测为键，跨组件重建存活。
- 其他：OSC 66 双倍高 H1、内联 hex 色卡、主题化表格边框、自定义 HR tokenizer。

### 7.2 LaTeX / 数学（**最大独立功能，值得移植**）

- `latex-to-unicode.ts`（**1994 行，新**）：bare-fragment LaTeX → Unicode/ANSI。覆盖上下标、希腊字母、大算符（`∫∑∏`）、关系/箭头、数学字体（Unicode Mathematical Alphanumeric block）、组合重音、简单分式、根式、矩阵，以及 `\textcolor`/`\color`/`\colorbox`/`\fcolorbox` 的 ANSI 颜色。
- `latex-block.ts`（**461 行，新**）：真正的二维 display 布局——baseline 对齐的 `Box` 引擎把 `\frac` 的分子/横线/分母**堆叠**起来，保持 `\\` 矩阵行。

> **关键判断**：~2450 行但**与渲染管线零耦合**，只需要 `visibleWidth` + 一个 `trueColor` 标志。唯一外部依赖是 `Bun.color`（用于 `\textcolor` 和 hex 色卡），可剥。**高价值 / 中 effort**——是单个最大的独立收益，能修一整类"数学被渲染成原始字符"的 bug（下划线、`\frac`、矩阵）。

### 7.3 文本 / Utils

- **Tab 宽度标准化**：oh-my-pi 删除了可配置 `tabWidth`，硬编码 `DEFAULT_TAB_WIDTH=3`（v16.0.11，breaking change）。我们还有可配置 tab width（`tab-width.test.ts`）。**低价值**——除非真想放弃可配置性，否则不跟。
- **`symbols.ts`（新，26 行）**：`SymbolTheme`/`BoxSymbols`（圆角/尖角/表格边框、`quoteBorder`、`hrChar`、`colorSwatch`、`spinnerFrames`），集中管理让 ASCII/Unicode/Nerd-font 主题干净降级。**中价值 / 低 effort。**
- **`fuzzy.ts` 重写**：word-local 匹配 + `SearchIndex`，防"image provider"跨无关词匹配。属于搜索排序，与渲染正交，**对我们低价值**。

---

## 8. 编辑器 / 自动补全 / 组件

### 8.1 三个可直接借鉴的新组件（低 effort）

| 组件 | 作用 | 可移植性 |
|---|---|---|
| **`box.ts` 的 border 特性** | `BoxBorder`（chars + 可选 color），画彩色边框；**内容放不下时自动去边框**，绝不溢出给定宽度 | **高价值 / 低 effort**（纯增量、向后兼容，替代我们手撸的边框） |
| **`ScrollView`** | 固定高度视口 + 可选右侧滚动条 + 标准滚动键；`totalRows` 让调用方传预切窗口而滚动条几何反映全量 buffer | **高价值 / 低 effort**（自包含，只依赖 utils/keys/tui，可用于 overlay/plan-review/任何有界列表） |
| **`TabBar`** | 水平 tab 栏，active/inactive/muted/hover 态，键盘循环跳过 muted，鼠标命中测试，溢出时从离 active 最远处先折叠 | **中价值 / 低 effort**（自包含，做多面板设置/视图时用得上） |

### 8.2 编辑器（全是真 bug 修复）

- **原子 token 安全的 word delete + grapheme word nav**：用 grapheme **kind classifier**（`utils.ts:288-434` 的 `WordNavKind`/`moveWordLeft/Right`）替换我们的 `Intl.Segmenter`，并让 word-delete 跨过 `[Paste #N]`/`[Image #N]` 这类原子占位符——**Ctrl+W / Alt+Backspace 不会再吃掉半个 marker**。**高价值 / 中 effort。**
- **内联且有界的 undo**：删除独立 `UndoStack` 类，改成私有数组 + `structuredClone` + `MAX_UNDO_STACK=100` + shift-oldest + 合并；`#withUndoSuspended`、`undoPastTransientText`（命令式自动补全不污染 undo）。**cap 100 是可移植的安全网**（我们目前无界）。
- **粘贴大修**：抽出 `bracketed-paste.ts`（修 tmux 重编码）；editor `#sanitizePastedText` 对 macOS NFD 拖拽做 NFC 归一化；`onLargePaste` 钩子 + `insertPaste`/`pasteText`。
- **`kill-ring.ts`**：加 60 条上限。

### 8.3 自动补全

- **前导空白 slash 命令 + 同步 Enter 补全**：`/` 是第一个非空白 token 即触发；Enter 在异步 provider resolve 前**同步**补全。修"缩进/空行后 slash 失效"和"Enter 时异步过期"。**高价值 / 中 effort。**
- **动态 slash 描述**：`SlashCommand.getAutocompleteDescription?: () => string`，仅在候选匹配时惰性求值。
- **skill 排序**：`skill:*` 命令在空前缀下可预测上浮。

### 8.4 现有组件改动

- **`loader.ts`**：从整树 `requestRender()` 切到**组件级 `requestComponentRender(this)`**，消除大 transcript 下 12.5Hz 整树重绘的卡顿；加 30fps `animated` 消息着色器、宽度夹紧、`dispose()`、同步输出感知。**高价值 / 中 effort**（需 TUI 的 `requestComponentRender` API）。
- **`select-list.ts`**（7.5KB→17KB）：type-to-filter 模糊搜索、两列描述折行、鼠标命中行映射。
- **`settings-list.ts`**（7.9KB→28KB）：基于 ScrollView 的滚动、type-to-search、分栏布局、子菜单、鼠标支持（**large，依赖 ScrollView+mouse**）。

---

## 9. 构建工具链与测试体系

### 9.1 工具链

| 轴 | 我们 | oh-my-pi |
|---|---|---|
| 运行时 | Node `>=22.19`，`node --test` | Bun `>=1.3.14`，`bun test --parallel` |
| 构建 | `tsdown` → `dist/index.mjs` + `.d.mts` | **无 bundler**，直接 ship `src/*.ts` |
| 类型检查 | `tsc --noEmit` | `tsgo --noEmit` |
| Lint/fmt | oxlint/oxfmt（仓库级） | Biome |
| 导出 | `#/*` 内部映射；公开 `exports` 仅 `"."` | `"."`、`"./*"`、`"./components/*"`、`"./*.js"`（每个模块都可深导入） |

**影响**：oh-my-pi 的 `./*` 深导出让消费方依赖内部文件布局——强大但脆弱。硬依赖 `@oh-my-pi/pi-natives` 意味着采纳其代码会拖入 Rust 工具链和 Bun-only API（`Bun.env`、`Bun.nanoseconds`、`Bun.hash`、`Bun.color`）。**我们的包保持 Node 可移植、自包含，这是优势。**

### 9.2 测试哲学

- **数量**：70 个 `*.test.ts`（含 helper 80）vs 我们 27/33。
- **issue 驱动回归**：10 个 `issue-XXXX-repro.test.ts` 钉到 GitHub issue。
- **属性/模糊测试**：`render-stress-*`（7 文件）——种子化随机场景、**oracle**、**delta-debugging reducer**（最小复现）、worker **scheduler**、隔离 **subprocess**。
- **真值 VT oracle**：`virtual-terminal.ts` 背后是 **Ghostty 真实 VT100 解析器编到 WASM**（`ghostty-web`），grapheme/ZWJ/BCE 正确——vs 我们的 `@xterm/headless` 近似。
- **Headless harness**：`process-terminal-render-harness.ts` + `setTerminalHeadless()` mock TTY 描述符，让全量渲染确定可测。
- **Benchmark**：`bench/` 微基准（`Bun.nanoseconds()`）。

> 我们是常规单元/组件 + 少量回归 repro；oh-my-pi 在"混沌下的渲染正确性"上投入远超我们。**render-stress 套件是最值得参考的测试资产。**

---

## 10. 可参考 / 移植建议（按 value/effort 分级）

> 总原则：**整体替换不可行**（Bun + Rust 耦合、工具链不同、会破坏我们的 Node 可移植性）。按模块 cherry-pick，优先摘"纯函数 / 自包含 / 有测试"的部分。

### 🟢 第一梯队：低 effort / 高 value（建议优先做）

| 项 | 位置 | 说明 |
|---|---|---|
| **SGR 合并** | `tui.ts:725-789` | 纯函数，每帧 SGR -30~40%，16 参数安全上限 + `PI_NO_SGR_COALESCE` 兜底。直接落到 emit 路径 |
| **Headless 测试模式** | `terminal.ts:410/470/1318` | 一个标志位贯穿 `start`/`safeWrite`，杜绝测试喷帧到开发者终端 |
| **崩溃安全 emergency restore** | `terminal.ts:236-280` | 一行门控，防 Windows 死帧残留 |
| **tmux xterm 变体 paste 修复** | `bracketed-paste.ts:37-41` | 我们已有一半，加一个 `27;5;n~` 分支 |
| **Box border** | `components/box.ts` | 纯增量、向后兼容，替代手撸边框 |
| **ScrollView** | `components/scroll-view.ts` | 自包含可复用视口，解 overlay/plan-review |
| **Markdown HTML 标签归一化** | `markdown.ts:127-227` | 纯函数，修 `<br>`/`<li>`/`<span>` 原样显示 |
| **undo cap 100** | editor | 给我们目前无界的 undo 加安全网 |

### 🟡 第二梯队：中 effort / 高 value（值得规划）

| 项 | 说明 |
|---|---|
| **StdinBuffer partial-hold + paste watchdog** | 修鼠标/转义尾巴漏文本 + 截断粘贴挂起；集中在 `stdin-buffer.ts`，最大用户可见输入鲁棒性收益 |
| **DA1 哨兵能力 FIFO + DECRQM 门控** | 修探测死等、DA1-before-kitty 排序；让 sync/resize/appearance 能力驱动而非无条件 |
| **粘贴大修（bracketed-paste + onLargePaste + NFC）** | 修 tmux/kitty/macOS 粘贴损坏；handler 文件可直接落，editor 接线是工作量 |
| **原子 token 安全 word delete + grapheme word nav** | 修 word-delete 吃半个 `[Paste/Image]` marker |
| **slash 自动补全前导空白 + 同步 Enter** | 修"缩进后 slash 失效"和 Enter 异步过期 |
| **Loader 组件级渲染** | 大 transcript 卡顿的真实性能收益（需 `requestComponentRender`） |
| **Kitty transmit-once + 稳定 id + ImageBudget** | 约束图像内存/scrollback 幽灵（需渲染器接线） |
| **增量 Markdown lex** | 流式渲染 O(N²)→O(N)，保正确 |
| **多路复用 + resize viewport defer** | 修 tmux scrollback 被清、resize 拖拽闪屏（部分自包含） |

### 🔵 第三梯队：高 effort / 高 value（长期架构演进）

| 项 | 说明 |
|---|---|
| **追加式 native scrollback 账本 + seam 契约** | 负载最重的核心修复，结构性消除 yank/闪屏/丢行；即使不整体移植也值得参照 |
| **范围感知 committed-prefix 审计** | "宁可重复不丢失"的重新排版恢复，durable-exempt 接缝是精髓 |
| **组件级渲染 + stable-prefix 帧模型** | 第二梯队 Loader 优化的前提 |
| **render-stress 模糊测试 + shadow ledger** | 合约定义 + 回归网，reducer/scheduler/subprocess 可直接采用 |
| **LaTeX → Unicode + 堆叠数学** | 最大的独立功能，与渲染管线零耦合，可单独立项移植 |

### ⚫ 不建议 / 需谨慎

- **整体换 bun + pi-natives（Rust）**：破坏我们的 Node 可移植性，得不偿失。
- **Sixel**：依赖 native sixel 编码器，且主要服务 Windows Terminal；暂缓。
- **深导出 `./*`**：让消费方依赖内部文件布局，脆弱；保持我们当前的 `"."` 入口更稳。
- **删除 tab-width 配置**：breaking + 低价值，除非产品真想放弃。
- **`fuzzy.ts` 重写**：搜索排序，与渲染正交，对我们低价值。
- **DECCARA**：除非"背景面板带宽"经测量确实是瓶颈，否则不优先（渲染器耦合 + kitty-only）。
- **`LoopWatchdog` 的 phase API**：依赖 `@oh-my-pi/pi-utils`，移植需先拆 phase 概念；价值中等。

---

## 11. 风险与注意事项

1. **Bun / Rust 耦合**：oh-my-pi 大量代码依赖 `Bun.*` API 和 `@oh-my-pi/pi-natives`（Rust NAPI）。移植时要把 `Bun.color`/`Bun.env`/`Bun.nanoseconds` 等换成 Node 等价物；凡是调用 pi-natives 的（sixel、keys、appearance）需重写或放弃。
2. **行号会漂移**：本报告引用的 oh-my-pi 行号对应其 16.1.16 版本，后续提交会移动。
3. **CHANGELOG 是自报的**：偶见中间状态后来被重构（如 v11.8 的 `UndoStack` 类现已不存在）。结论以代码为准。
4. **Breaking changes 多**：oh-my-pi 的 16 个大版本里有 11 处 breaking change（删 `isXxx()` key helper、改 `Editor` 构造、删 `getCursorPosition()`、删 `terminal-image` 导出、删 tab-width 配置等）。参考时**不要照搬 API 形态**，只借鉴机制。
5. **我们的优势要保留**：Node 可移植、自包含、无 Rust 依赖、overlay focus 模型更细。移植时不应牺牲这些。
6. **未跑测试**：本次调研为只读静态分析，所有"证据"来自源码 + 测试源 + 注释 + CHANGELOG，未实际执行任一测试套件。

---

## 12. 结论与建议路线

oh-my-pi 对 pi-tui 的改造可以归纳为一条主线：**把"差分渲染"升级成"保护 native scrollback 的流式会话运行时"**，并围绕它补齐了终端能力协商、输入鲁棒性、图像/数学/Markdown 渲染、可测试性。

建议分三步走：

1. **Quick wins（1-2 周）**：SGR 合并、Headless 模式、emergency restore、tmux paste 变体、Box border、ScrollView、Markdown HTML 归一化、undo cap。这些都是低风险、有测试、可直接落地的，能立刻改善帧体积、测试体验和若干输入/显示 bug。
2. **输入与能力（2-4 周）**：StdinBuffer partial-hold + paste watchdog、DA1 哨兵能力 FIFO + DECRQM 门控、粘贴大修、word-delete marker 修复、slash 补全修复。系统性提升输入鲁棒性和跨终端兼容。
3. **架构演进（按季度规划）**：参照 append-only native scrollback 账本 + seam 契约 + render-stress 模糊测试，逐步把我们的渲染器迁移到"保护 scrollback"的模型；并行评估 LaTeX 数学渲染作为一个独立可交付功能。

**最高优先级的参照物**：render-stress 模糊测试套件（它定义了合约、能拦住任何后续移植的回归）和 SGR 合并（最低成本、最确定的字节体积收益）。

---

## 附录：信息来源

- 本报告由对两个 fork 的静态源码对比、oh-my-pi 的 `packages/tui/CHANGELOG.md`（1775 行 / 152 版本）、以及 `oh-my-pi/docs/` 下的 `tui-core-renderer.md`、`tui-runtime-internals.md`、`tui.md`、`keybindings.md` 综合而成。
- oh-my-pi 关键模块行号：渲染核心 `tui.ts`（3695 行）、终端 `terminal.ts`、`terminal-capabilities.ts`（1049 行）、`kitty-graphics.ts`、`latex-to-unicode.ts`（1994 行）、`latex-block.ts`（461 行）、`bracketed-paste.ts`、`mouse.ts`、`deccara.ts`、`ttyid.ts`、`loop-watchdog.ts`。
- 我们关键模块：`tui.ts`（1714 行，`doRender` 在 `:1254-1620`）、`terminal.ts`、`terminal-image.ts`、`terminal-colors.ts`、`components/markdown.ts`（858 行）、`editor.ts`、`autocomplete.ts`。

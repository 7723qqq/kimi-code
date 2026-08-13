# TS 旧版 vs Rust 现状 — 差异目录（2026-08-13 审计）

> 用途：逐项对照 TS 旧版（`retired/kimi-code-src/` + git 历史 `cba21d159^` 的 TS TUI）与 Rust 现状（`crates/*`），记录所有用户可见差异，作为后续修正清单。
> 审计方法：4 个子代理并行逐面对比（命令面/交互组件/CLI/i18n），差异均带 `文件:行` 证据。
> 优先级：🔴 高（bug/危险/核心功能缺口）→ 🟡 中 → 🟢 低。

---

## 一、TUI 命令面差异（Item 1）

### A. 命令缺失或仅占位（TS 有、Rust 无/占位）

| # | 命令 | 差异 | Rust 位置 | 优先级 |
|---|---|---|---|---|
| A1 | `/export-debug-zip` | **已修复（2026-08-14）**：新增命令承接 zip 导出（`{session_id}.zip` + tui.export.done），TS registry 证实为独立命令 | commands.rs /export-debug-zip 分支 | 🟡→✅ |
| A2 | `/skill:<name>` 技能命令 | 缺失，一律 unknown command | commands.rs:135-138 | 🔴 |
| A3 | `/<pluginId>:<command>` 插件命令 | **已修复（2026-08-14）**：真执行——首个 `:` 拆分 + 已注册插件校验（errNotFound/errUnknownCommand）→ `activate_plugin_command`（引擎 $ARGUMENTS 展开 + run_prompt）；`/foo:`/`/:foo` 落回普通消息（TS parity）；Tab 补全 `complete_plugin_arg` 纯函数已加（app.rs 惰性缓存接入待下轮） | commands.rs plugin_command_parts；bottom_pane.rs | 🟡→✅ |
| A4 | `/experiments` | **部分修复（2026-08-14）**：交互版——secondary-model 开关（picker + harness.set_config 写 config.toml）+ env 门控状态展示 + `secondary on/off` 命令形式；TS 6 flag 中其余 5 个无 Rust config 数据面（诚实标注）；顺带修复旧代码读 snake_case 键永远 none 的 bug | commands.rs /experiments 分支 | 🟡→✅(secondary)/🟡(其余) |
| A5 | `/multi-llm` | **标注（2026-08-14）**：列出已配置 providers；TS 勾选持久化无 Rust 数据面（KimiConfig 无 multiLlm 字段，多 LLM 路由由会话 RPC providers 参数驱动）——非完成项，标注待引擎 | commands.rs /multi-llm 分支 | 🟡 待引擎 |
| A6 | `/feedback` | 仅提示，TS 为完整反馈提交（含附件） | commands.rs:1190-1192 | 🟢 |
| A7 | `/web` | **已修复（2026-08-14）**：spawn 自身二进制 `web` 子命令（detached：Windows DETACHED_PROCESS+新进程组 / Unix process_group），成功提示 `http://127.0.0.1:58627`，失败报错；TS 的深链/退出接管不涉及 | commands.rs:1575-1591 | 🟡→✅ |
| A8 | `/provider add` | **已修复（2026-08-13）**：catalog 导入（models.dev）→ 默认模型选择器 → 写 providers+models 到 config.toml；`--api-key <key>` 可选；自定义 registry 提示走 CLI | commands.rs:1220 | ~~🔴~~ ✅ |
| A9 | `/login` 平台选择 | 仅 kimi OAuth；TS 有 kimi-code/开放平台 API key/Astron 三选 | commands.rs:52-128 | 🟡 |
| A10 | `/logout` 选择器 | 直接登出托管账号；TS 列出可登出 provider | commands.rs:129-134 | 🟢 |
| A11 | `/reload` | 仅 session.load()；TS 还重载 config.toml/tui.toml/experimental/autocomplete | commands.rs:919-928 | 🟡 |
| A12 | `/reload-tui` | 仅重载 locale+theme；TS 重载 tui.toml 全字段 | commands.rs:929-938 | 🟢 |

### B. 同名命令语义/参数差异

| # | 命令 | 差异 | Rust 位置 | 优先级 |
|---|---|---|---|---|
| B1 | `/exit` | **已修复（2026-08-13）**：commands.rs `/quit` 分支并入 `/exit` | commands.rs:1211 | ~~🔴~~ ✅ |
| B2 | `/clear` | **已修复（2026-08-14）**：改为 `/new` 别名（TS registry `new` aliases `['clear']`），复用 /new 分支 | commands.rs /clear 分支 | ~~🔴 语义相反~~ ✅ |
| B3 | `/resume` | **已修复（2026-08-13）**：无参走 /sessions 选择器（TS alias 语义）；带 id 恢复持久化状态 | commands.rs:539-552 | 🟡→✅ |
| B4 | `/export` | **已修复（2026-08-14）**：改为 export-md 别名（抽 export_markdown 辅助函数共用；TS registry `export-md` aliases `['export']`），zip 移至 /export-debug-zip | commands.rs /export 分支 | ~~🔴 语义相反~~ ✅ |
| B5 | `/config` | **已修复（2026-08-14）**：改为 /settings 别名（TS registry `settings` aliases `['config']`），复用 /settings 分支 | commands.rs cmd_config | 🟡→✅ |
| B6 | 未知命令 `/foo` | **已修复（2026-08-13）**：未命中的 `/` 行作为普通消息发给模型（TS parity，含路径类） | commands.rs:135 | ~~🔴~~ ✅ |
| B7 | `/yolo off` | **已修复（2026-08-13）**：解析 on/off/toggle，目标态提示，不再反向 | commands.rs:768 | ~~🔴~~ ✅ |
| B8 | `/auto off` | **已修复（2026-08-13）**：同上 | commands.rs:785 | ~~🔴~~ ✅ |
| B9 | `/plan <非法值>` | TS 仅 clear/on/off 否则报错；Rust 任意值当 off | commands.rs:681-704 | 🟡 |
| B10 | `/swarm <任务>` | **已修复（2026-08-13）**：on/off/toggle 之外视为一次性任务（开启+触发+run_turn） | commands.rs:1559 | ~~🔴~~ ✅ |
| B11 | `/goal`（空参） | **已修复（2026-08-14）**：显示 goal 状态；**真正修复取值路径**——SDK goal() 返回 `{goal: snapshot}`，旧代码取 `["result"]["goal"]` 恒 null 导致永远显示 no active goal | commands.rs:260-271 | 🟢→✅ |
| B12 | `/goal <objective>` | **已修复（2026-08-13）**：创建后立即 run_turn 启动回合（TS parity） | commands.rs:359-366 | ~~🔴~~ ✅ |
| B13 | `/goal pause xxx` | **已修复（2026-08-13）**：仅唯一 token 才是子命令（`"pause" if objective.is_empty()` 守卫，`pause xxx`=创建目标） | commands.rs:288-295 | 🟡→✅ |
| B14 | `/goal next manage` | **部分修复（2026-08-14）**：交互版——picker 选队列项 → move up/down/delete/back 循环；edit 无引擎 API（TS updateGoalQueueItem 无 Rust 对应）标注缺口 | commands.rs manage_goal_queue | 🟡→✅(move/del)/🟡(edit) |
| B15 | `/fork` | TS 无参 fork 当前会话并**切换**；Rust 无参 usage、不切换 | commands.rs:482-493 | 🟡 |
| B16 | `/title`（空参） | TS 显示当前标题；Rust usage；无 200 字符截断 | commands.rs:450-461 | 🟢 |
| B17 | `/export-md` | TS 文件名 `kimi-export-<id8>-<时间戳>.md`+workDir+会话检查；Rust 固定 `{session_id}.md` 当前目录 | commands.rs:641-652 | 🟡 |
| B18 | `/undo` | TS 支持 count/streaming 拒绝/compaction 提示/交互选择器；Rust 固定 1 无检查 | commands.rs:1739-1750 | 🟡 |
| B19 | `/model` | TS 校验 alias+定位 picker+可持久化 defaultModel；Rust 不校验不持久化 | commands.rs:869-918 | 🟡 |
| B20 | `/thinking` | TS 校验模型 effort 段+会话/持久模式；Rust 直接 set | commands.rs:705-716 | 🟡 |
| B21 | `/theme` | **已修复（2026-08-14）**：自定义主题（`~/.kimi-code/themes/*.json`，hex #RGB/#RRGGBB，失败回退 dark）+ picker 列出自定义主题 + 加载失败报错不持久化；auto 检测仍≈dark（见 #19） | commands.rs:1005-1069；theme.rs | 🟡→✅ |
| B22 | `/editor`（空参） | TS 打开编辑器选择器；Rust 仅显示当前命令 | commands.rs:983-1004 | 🟢 |
| B23 | `/settings` | **已补齐（2026-08-14）**：TS 10 项全在——新增 github_token / astron（引擎无 experimental 段与 Astron 扩展字段，选中显示真实状态与缺口提示）；TS 门控项 astron 按实际可见 | commands.rs /settings 分支 | 🟡→✅ |
| B24 | `/add-dir` | TS 有 list/确认/remember 持久化；Rust 直接添加 | commands.rs:1679-1700 | 🟡 |
| B25 | `/btw`（空参） | TS 空参也启动侧问面板；Rust usage | commands.rs:596-598 | 🟢 |
| B26 | `/init` | **已修复（2026-08-14）**：模型未设置时 `tui.err.llmNotSet` 拒绝（ensure_model_set 检查）；defer 用户消息为 TS 流控概念，Rust run_turn 同步驱动无对应 | commands.rs /init 分支 | 🟢→✅ |
| B27 | `/discuss` | TS 完整语法（--debate/with/role:stance/配置 JSON/maxRounds）；Rust 简化 | util.rs:75-109 | 🟡 |
| B28 | `/workflow` | **已修复（2026-08-14）**：无参 6 行 usage 面板（helpList/helpRun/helpStatus/helpCancel/helpExample）；status/cancel 无 id → usage；模型驱动分支统一 ensure_model_set | commands.rs /workflow 分支 | 🟢→✅ |
| B29 | `/copy` | TS 只复制 modelText（排除 hook/目标卡片）；Rust 复制最后一条 Assistant | util.rs:114-122 | 🟢 |
| B30 | `/usage` | TS 面板含 managed usage；Rust 文本无 | commands.rs:1717-1738 | 🟡 |
| B31 | `/status` | TS 面板含 workDir/title/models/managedUsage；Rust 6 行文本 | reports.rs:65-91 | 🟡 |
| B32 | `/compact`（无参） | TS 弹确认对话框；Rust 直接执行 | commands.rs:1701-1716 | 🟢 |

### C. Rust 多余命令（非 TS parity，建议保留并标注）
`/approvals` `/approve` `/deny`（TS 走 UI 弹窗）、`/info`、`/session set`、`/skills`（TS 是面板）、`/steer` `/import` `/archive` `/endbtw`（TS 是快捷键/UI）、`/models`、`/locale`、`/goal-cancel/pause/resume/status`（`/goal-status` 输出原始 JSON，建议对齐报告格式）。

### D. 别名/注册表差异
- 🔴 冲突：`config`（TS=settings 别名）、`clear`（TS=new 别名）、`resume`（TS=sessions 别名）、`export`（TS=export-md 别名）在 Rust 被占为独立命令
- 🟡 缺失别名：`/multillm`、`/experimental`
- ✅ 等价：`yes`→yolo、`h`/`?`→help、`task`→tasks、`thinking`→effort、`providers`→provider、`disconnect`→logout、`rename`→title、`quit`/`q`→exit
- 🟡 缺失：TS 的命令 availability（idle-only/always）与 busy 阻塞（streaming/compacting 时拦截）——Rust 无

---

## 二、TUI 交互与渲染差异（Item 2）

| # | 交互 | 差异 | Rust 位置 | 优先级 |
|---|---|---|---|---|
| 1 | bash 模式（`!`） | **输出已流式化（2026-08-13）**：`!cmd` 经 `session.shell.output` 事件实时上屏（TS shell-run parity），失败标记；历史召回保留 `!` 前缀（Rust 语义正确）；独立 bash 模式（边框提示）仍需 inputMode 重构（中远期） | commands.rs:146 | 🟡→主体 ✅ |
| 2 | Ctrl-D 双击退出 | 缺失 | — | 🟡 |
| 3 | 双击 Esc → undo 选择器 | **已修复（2026-08-13）**：600ms 内二按 Esc 触发 `/undo`，不再退出；窗口外单击 Esc 仍退出 | app.rs:869 | ~~🔴~~ ✅ |
| 4 | Shift-Tab → plan 切换 | 缺失 | — | 🟡 |
| 5 | Ctrl-T todo 面板 | 缺失（无 todo 渲染） | — | 🟢 |
| 6 | Ctrl-B | TS 运行中 detach 前台任务；Rust 打开 /tasks 浏览器（语义相反） | app.rs:715-720 | 🟡 |
| 7 | Up 空输入召回排队消息 | 缺失（无队列概念） | app.rs:832-852 | 🟢 |
| 8 | Ctrl-S steer | TS 仅 streaming 有效+steer 队列（非 bash 消息+草稿）；Rust 无条件直接 steer | app.rs:694-713 | 🟡 |
| 9 | 审批面板 | TS 多选项/数字键/requires_feedback 原因输入/Ctrl-E diff 预览/Ctrl-O 展开输出；Rust 固定 y/n/s/v+deny reason 硬编码 | app.rs:1267-1313 | 🟡 |
| 10 | 审批桌面通知 | 缺失 | — | 🟢 |
| 11 | 模型选择器 | **已增强（2026-08-13）**：`/model` 选中模型后追加 thinking effort 选择器（keep/off/low/medium/high，Esc 保持）——TS model-selector effort 段的会话级等价 | commands.rs:962 | 🟡→✅（←/→ 内联切换与 Alt+S 会话级持久未做） |
| 12 | choice-picker 键位 | TS Left/Right 翻页+Alt+S+Space 选中；Rust 无 | picker.rs:243-308 | 🟢 |
| 13 | 选择器过滤 | TS fuzzy；Rust 子串包含 | picker.rs:57-66 | 🟢 |
| 14 | 会话选择器 | **已增强（2026-08-13）**：标题为主行 + `id · work_dir · 相对时间` + 当前 `●` 标记；**Ctrl-A 切换 cwd/all scope**（新增 `select_picker_with_hotkeys` 通用钩子，默认仅当前目录会话） | commands.rs:516；picker.rs | 🟡→✅ |
| 15 | 会话恢复 replay | **已完整实现（2026-08-14）**：引擎 `session/resume_state` RPC（record_store 12 类记录按序映射：message/turn/tool.call/result/goal/compaction/usage + plan.updated/permission.updated/approval.result + background 终态 + toolStore.todo）；SDK `resume_state()`；TUI replay.rs 渲染器（user/assistant/tool 消息 + shell_command/hook_result(markdown 助手行)/skill/plugin/cron_job/cron_missed/background_task origin + tool 卡片配对 + goal 生命周期 + compaction + plan/permission 状态行 + approval 结果含 ExitPlanMode 抑制链）+ todo 面板（输入区上方，`session.todo.updated` live 更新）+ startup/switch_to_session 双接入；cron/hook 按引擎 snake_case wire 读取 | replay.rs；agent.rs resume_state()；app.rs | 🟡→✅ |
| 16 | 输入历史持久化 | **已修复（2026-08-13）**：JSONL 存 `~/.kimi-code/user-history/<hash(cwd)>.jsonl`（KIMI_CODE_HOME 感知），启动恢复 + 提交追加（去空/连续去重/损坏行跳过），`!` 行原样保存 | util.rs 471-552；app.rs run()/Enter | 🟡→✅ |
| 17 | Tab 补全覆盖 | **已修复（2026-08-14）**：`/skill:` 技能名补全 + `/<pluginId>:` 插件命令补全（complete_plugin_arg 纯函数 + app.rs 惰性缓存聚合 list_plugins/list_plugin_commands） | bottom_pane.rs；app.rs complete() | 🟡→✅ |
| 18 | 补全自动弹出 | **已核实实现（2026-08-14）**：输入变化即 `completion_for_input` → Completion overlay（↑/↓ 移动 Enter 填充 Esc 关闭） | app.rs:1516 | 🟢→✅ |
| 19 | 主题 auto 检测 | TS OSC11/CSI ?997 终端背景检测；Rust auto≈dark | theme.rs:88-95 | 🟡 |
| 20 | 自定义主题 | **已修复（2026-08-14）**：`~/.kimi-code/themes/*.json` 加载（KIMI_CODE_HOME 感知、缺失 token 补 dark、hex #RGB/#RRGGBB、失败回退）+ 目录扫描列出 | theme.rs:239-300 | 🟡→✅ |
| 22 | 帮助面板键位 | **已核实实现（2026-08-14）**：q/Q 关闭 + PageUp/PageDown 翻页（TS parity）+ Esc/Enter 关闭 | app.rs:1319-1326 | 🟢→✅ |
| 24 | 剪贴板图片粘贴 | **部分修复（2026-08-14）**：PNG/JPEG/GIF/BMP 四格式（FileDrop 优先→原生格式字节→GDI+ PNG 兜底）+ 魔数检测 + 手写尺寸解析（PNG IHDR/JPEG SOF/GIF LSD/BMP 头含裸 DIB）+ `[image #N (W×H)]` 尺寸占位（U+00D7，expand 兼容）；视频/EXIF 方向/压缩标注未做（引擎无 video_url 管道、无图像库依赖） | clipboard.rs；app.rs Alt-V | 🟡→✅(四格式+尺寸)/🟡(视频/EXIF) |
| 27 | Ctrl-C 优先级链 | **部分修复（2026-08-14）**：btw 关闭（优先于双击）→ streaming 取消（清 arm 防误退）→ 双击退出（1500ms，TS 一致）→ 首按清空输入+arm；cancelInFlight/compacting 级注明：login/compact 同步 await 阻塞事件循环，Ctrl-C 不可达（结构限制，代码注释说明） | app.rs idle_ctrl_c_action | 🟡→✅(btw/streaming/双击)/🟡(cancelInFlight/compacting) |
| 30-31 | tmux/终端主题跟踪 | 缺失 | — | 🟢 |
| 35 | 任务浏览器 | TS 全屏浏览器+输出全屏查看器；Rust 两步 picker+折叠行 | commands.rs:1302-1666 | 🟡 |
| 36 | footer goal badge | **已修复（2026-08-14）**：TS 格式对齐 `[goal ● active · 4m · 7/20 turns]`（状态本地化 + 耗时跳动 active 才走 + budget turns 单复数）；GoalBadge 结构化缓存（事件驱动 + resume 播种 + 队列提升播种） | footer.rs GoalBadge / app.rs | 🟢→✅ |
| 38 | streaming 渲染 | **部分修复（2026-08-14）**：thinking 折叠对齐 TS——Ctrl+O 全局 `tool_output_expanded` 翻转 + 折叠显示尾部 2 行 + `… (+N lines, ctrl+o to expand)` 截断标记（truncate_hint 宽度截断）；tool-call 分组（AgentGroup/ReadGroup 同 step 合并）属 tool 渲染范畴，注明差异未做 | chatwidget.rs thinking_lines；app.rs Ctrl+O | 🟢→✅(折叠/截断)/🟡(分组) |

**已确认等价**：行编辑基础键（Ctrl-A/E/U/K/W、Home/End、多行）、Ctrl-G 外部编辑器、Tab 补全核心、bracketed paste、PageUp/Down+滚轮（本轮已补）、双击 Ctrl-C 退出、Alt-V 图片粘贴、AskUserQuestion 对话框、/locale、/theme 三选一、审批 y/n/s/v、goal 队列自动 promote。

---

## 三、CLI 面差异（Item 3）

| # | 项 | 差异 | Rust 位置 | 优先级 |
|---|---|---|---|---|
| B1 | `-p` text 输出 | **已修复（2026-08-13）**：非 TTY 管道时 assistant delta 流式裸文本写 stdout（TS session-engine parity），跳过 post-hoc bullet 块；TTY 行为不变（stderr 流式 + stdout 块） | main.rs:1463-1468,3214 | ~~🔴~~ ✅ |
| B2 | `-p` stderr 诊断 | **已修复（2026-08-13）**：stdout 管道时捕获事件，tool/goal/用量诊断写 stderr（实测：turn started/llm started/tokens/usage/turn ended） | main.rs:3091-3094 | ~~🟡~~ ✅ |
| B4 | stream-json retrying | 缺失（TS `turn.step.retrying` meta 行） | main.rs:425-472 | 🟡 |
| B5 | stream-json hook.result | 缺失（TS 输出 assistant 行） | 同上 | 🟢 |
| B6 | resume hint | **已修复（2026-08-13）**：统一 `kimi -r {id}`（与 stream-json meta 一致，可直接执行） | i18n.rs:1140-1143 | ~~🔴~~ ✅ |
| B7 | `-c` 无历史 | TS stderr 提示后新建；Rust 静默 | main.rs:3117-3123 | 🟢 |
| B8 | config 诊断警告 | TS 运行前输出 warnings；Rust 无 | — | 🟢 |
| C2 | `doctor` | Rust 额外检查引擎（不可用 exit 1）+输出摘要块；TS 仅文件校验 | main.rs:3551-3602 | 🟡 |
| C3-C4 | `export` 提示/路径 | 提示缺 title；输出相对路径（TS 绝对路径） | main.rs:4292,4331 | 🟢 |
| C6 | `upgrade` | TS 可交互安装；Rust 仅查版本打印命令 | main.rs:2892-2915 | 🟡 |
| C7 | `upgrade` 文案 | Rust 硬编码英文 | main.rs:2912 | 🟡 |
| C8 | `login` 输出 | TS 全写 stderr+i18n+SIGINT 取消；Rust 写 stdout+硬编码+无信号处理 | main.rs:824-870 | 🟡 |
| C10 | `provider add` | TS 先清 stale 再写；Rust 直接覆盖（旧别名残留） | main.rs:3927-3956 | 🟡 |
| C11-15 | `provider catalog` 输出 | **已修复（2026-08-13）**：C11 钻取能力标注、C12 表格 wire/guessed、C13 JSON 归一化、C14 空模型报错、C15 导入成功文案（"Imported {name} ({id}) with N models from {url}." + 默认模型行）——全部 TS 对齐 | main.rs:4108-4421 | 🟡→✅ |
| C17 | `web` 非 loopback 默认 | TS `--insecure-no-tls` 默认 true（LAN 可用）；Rust 默认 false（**注释与实现自相矛盾**） | main.rs:1072-1076,602-607 | 🔴 |
| C18 | `web --log-level` | TS 有效值可用；Rust 一律 not supported | main.rs:569-581 | 🟢 |
| C19 | `web` ready 输出 | TS 完整 banner；Rust 一行 | main.rs:635 | 🟢 |
| C20 | `web rotate-token` | TS 输出运行中 server access links；Rust 仅 token | main.rs:738-749 | 🟢 |
| C21 | `server kill` | **TS 保留可用（legacy-kill）；Rust 一律拒绝 exit 1**（测试显式断言拒绝） | main.rs:3759-3765 | 🟡 待决策 |
| C22 | `vis` | TS 完整启动 vis-server；Rust notBundled exit 1 | main.rs:3814-3820 | 🟡 待决策 |

**已确认等价**：顶层选项解析（-S/-r/-c/-C/-y/--yes/--auto-approve/--auto/--plan/-m/--add-dir/--skills-dir）、validateOptions 冲突路径、KIMI_MODEL_OUTPUT_FORMAT、goal 模式（退出码 0/3/6、`--` 语法、4000 上限）、-S 跨目录拒绝、export 默认 zip 名与确认逻辑、provider list/remove、web host/port/allowed-host、acp、`-p` 权限强制 auto。

---

## 四、i18n 文案差异（Item 4）

**规模**：TS TUI locale 1637 key（tui.* 1519）vs Rust 字典 444 key（全新命名空间，自洽：444 全被引用、0 未定义）。语义可对应约 110 项。

### 高优先级（zh 用户可见英文）

| # | 位置 | 内容 | 建议 |
|---|---|---|---|
| 75 | kimi-cli main.rs:1915-1947 | chat REPL `/help` 约 30 行硬编码英文 | **评估：chat 是阶段 D 纯文本原型（非主界面，主界面为 TUI）**——i18n 投入收益低，降为 🟢 低优先 |
| 76 | kimi-cli main.rs:1972-2524 | chat REPL 命令反馈约 15 条硬编码 | 同上，🟢 低优先 |
| 82 | kimi-tui approval.rs:105-149 | 审批预览 tool 行 9 处 + "(no change)" 硬编码 | **已修复（2026-08-13）**：新增 `tui.approval.{edit,write,bash,read,grep,glob,search,webFetch,task,noChange}` 10 个 key 并替换 | ✅ |
| 83 | kimi-tui picker.rs:93 | `no match: {filter}` 硬编码，**字典已有 `tui.picker.noMatch` 未用** | **已修复（2026-08-13）**：改用 `t!` | ✅ |

### 中优先级
- main.rs 其余硬编码（#77-81）：**#77/#78/#79/#81 主体已修复（2026-08-13，15 个新 key：跨目录/web/OAuth/upgrade/export/provider）**；catalog 输出格式对齐（C11-C15）与 clap doc 双源同步（#85）待后续
- clap doc 注释与字典 en 双源同步（#85）

### 低优先级（语义简化，非缺陷）
- 命令描述措辞差异 58 处（/help 面板、--help）：多为精简改写，是否对齐取决于产品意图
- TS-only 1632 key：多数对应功能未移植（对话框/面板），无修正对象

**已确认等价**：`tui.dangerPatterns.*` 8 条逐字一致、`cli.print.promptEmpty/modelEmpty`、`cli.opts.*` 冲突 4 项、`tui.cmd.plugins/plan/btw`。

---

## 五、快速修复清单（第一梯队，按优先级）

### 🔴 立即修（bug/危险/核心）
1. ~~**`/exit` 不退出**~~ ✅（commands.rs `/quit` 并入 `/exit`）
2. ~~**双击 Esc 直接退出程序**~~ ✅（600ms 双击窗口 → `/undo`）
3. ~~**`/yolo off`、`/auto off` 反向**~~ ✅（解析 on/off/toggle + 目标态提示）
4. ~~**`/swarm <任务>` 被当 off**~~ ✅（on/off/toggle 之外为一次性任务）
5. ~~**`/goal <objective>` 创建后不启动回合**~~ ✅（创建后 run_turn）
6. ~~**resume hint 不可执行**~~ ✅（统一 `kimi -r {id}`）
7. ~~**未知命令 `/foo` 应作为普通消息发给模型**~~ ✅（未命中命令回落普通输入）
8. **`web` 非 loopback 默认 TLS 注释与实现矛盾**（main.rs:602-607 → 对齐 TS 默认或修注释；**安全相关，待决策**）
9. ~~**bash 模式历史召回双重执行**~~ → 分析后为**有意简化**（Rust 语义无双重执行；完整 bash 模式中远期）
10. **别名冲突已全部对齐（2026-08-14）**：`/clear`→new、`/export`→export-md、`/config`→settings、`/resume`→sessions（均按 TS registry aliases 对齐，原 Rust 独立语义的命令面迁移：clear_context 移除、zip 移至 /export-debug-zip、config JSON 查看移除）

### 🟡 次批
- `-p` text 输出对齐 TS（流式裸文本 stdout + `[tool]`/`[goal]` 诊断）
- `/provider add`、`/experiments`、`/multi-llm` 占位实现
- 审批面板反馈原因输入；模型选择器 effort 段；会话选择器 scope；输入历史持久化；~~skill 补全源~~（✅ 2026-08-14）/plugin 补全源
- i18n 高优先 4 项（chat REPL/审批预览/picker no-match）

### 🟢 低/待决策
- `server kill`、`vis` 恢复与否（产品决策）
- ~~自定义主题~~（✅ 2026-08-14）、主题 auto 检测、streaming 渲染增强、帮助面板键位

---

## 六、审计边界说明

- TS 基准 = `retired/kimi-code-src/`（CLI/i18n）+ git `cba21d159^:apps/kimi-code/src/tui/`（TUI，已删除，从历史读取）
- 引擎内部实现差异（agent-core vs kimi-agent 的会话/工具/上下文语义）**不在本次范围**——本次聚焦用户可见面（命令/交互/输出/文案）
- 已知简化项（§6.4 定案保留：agent-group 组卡片、banner 网络拉取、easter-eggs）不在本目录重复列出

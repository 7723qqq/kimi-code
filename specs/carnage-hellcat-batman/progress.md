# Progress

## 状态

**T1–T6 完成，T7 进行中。** 三份计划文档与调研材料见同目录。

---

## T1 — 并发会话检查：完成（含两处更正）

### 更正 1：我把自己的进程认成了"另一个会话"

最初记录的风险基于**错误的进程归属**：

- PID 1496825 是 **pts/0、07:26:51 启动**。追溯我自己 bash 的父进程链：
  `1508xxx → 1496825 → 1496668 → Relay → SessionLeader`。
  **1496825 就是当前会话本身**（`session_9d79f688`）。
- 真正的并发进程是 **PID 1493757**（pts/2，07:16:21 启动），对应
  **`session_0de4a015`**。

### 更正 2：覆盖机制不是"并行编辑"，是一次批量回滚

取自 `session_0de4a015/agents/main/wire.jsonl`：

- `07:44:32` think：`I made a mistake — my broad deletion removed ...`
- `07:44:41` think：`74 files changed in agent-core-v2 — but I only ...`
- `07:44:56` 执行：

  ```python
  out = subprocess.run(['git','status','--porcelain','packages/agent-core-v2'], ...)
  tracked = [ ... ]          # 跳过 ?? 未跟踪项
  subprocess.run(['git','checkout','--'] + tracked, check=True)
  ```

  输出：`restoring 73 tracked files`

该会话批量删除时误伤文件，于是回滚了 `packages/agent-core-v2` 下**全部 73 个已跟踪的修改
文件**。当时写入的 `promptOptimizer.ts` 修复正在其中。**它并非针对本缺陷。**

### 判定与防护

`session_0de4a015` 的目标是 `goalService.ts` 与错误码表统一，不针对 `promptOptimizer/`。
但**它已执行过一次批量回滚，可能再次执行**，因此采取防护而非等待：

1. 小步改，每步立即验证；
2. 在 `specs/carnage-hellcat-batman/recovery/` 保存 8 个文件的恢复副本
   （spec 目录不受其 `git checkout -- packages/` 影响）；
3. **不提交他人改动**。首次尝试 `git add` 时发现 `errors.ts` 与 `node-sdk/errors.ts`
   的暂存区混入了该会话的改动（删除 `title`/`action` 字段、移除 `resolveErrorTitle`），
   已 `git reset` 取消暂存，改为副本保护。

---

## T2 — 提示词重写：完成

`packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts`

11 条规则重组为 7 条。验收自检：

| 检查 | 结果 |
| --- | --- |
| 规则条数在 5–7 | ✅ 7 |
| 含命名要求（`Improve by naming` + `write that name in place of the vague reference`） | ✅ |
| 含"具体而非更长"判据 | ✅ |
| 含禁止措辞替换（`Keep the draft's own words` + `Never trade a plain word`） | ✅ |
| 移除绕过路径 `the user did not imply` | ✅ 0 次出现 |
| 保留语言约束（`Write in the draft's language`） | ✅ |
| 保留不回答约束（`Do not answer the draft`） | ✅ |
| 工具条款收束（`not investigating it`） | ✅ |

### 过程中的两次实测修正（重要）

**修正 A — 我原设计里"把长度约束降级为判据"是错的？否，实测否定了我的第一反应。**

三臂对照实验（同模型，6 草稿 × 5 轮，取长度比中位数）：

| 变体 | 平均中位数 |
| --- | --- |
| `cur`：无显式长度约束 | 2.19 |
| `A`：加回显式长度约束 | 2.16 |
| `B`：长度约束 + 禁止把工作目录当作命名对象 | **1.74** |

结论：加回长度约束**几乎没有效果**（2.19→2.16），个别用例反而更差
（`请完整进行优化` 5.71→6.57）。**决定性因素是 B 那条。**

**修正 B — 设计里的实质错误：给了命名通道，却没限定什么值得命名。**

`design.md` §1.2 原文允许"当会话上下文**或工作目录**已确定草稿所指对象时写出真名"。
实测发现模型据此把**工作目录路径**当作"真名"，产出
`请完整优化 /home/administrator/kimi/kimi-code 项目`（7 字 → 44 字）。
而工作目录本来就在提示词里给过下游 agent，写进去是**零信息**。

已修正为：`Do not name the working directory: the agent is already given it, so writing it in adds nothing.`

---

## T3 — 截断可见化：完成

| 改动 | 文件 |
| --- | --- |
| 恢复 `PROMPT_OPTIMIZER_TRUNCATION_MARKER = '…(truncated)'` | `promptOptimizer.ts` |
| `clamp()` 追加标记 | `promptOptimizerService.ts` |
| 删除 `clampOutput()`，超长改为抛 `PROMPT_OPTIMIZER_OUTPUT_TOO_LONG` | 同上 |
| 注册新错误码 | `features/promptOptimizer/errors.ts` |
| 镜像新码到 SDK 码表与 `KIMI_ERROR_INFO` | `packages/node-sdk/src/errors.ts` |
| 修正 `prompt_optimizer.no_output` 的 `retryable` 分歧（SDK `false` → `true`，与引擎一致） | 同上 |

验收：

- `marks a draft that exceeds the input limit as truncated` ✅（恢复 F9 的断言）
- `does not mark a draft that fits as truncated` ✅（恢复被删的测试）
- `rejects an over-long rewrite instead of returning it truncated` ✅
- 删除 `backs the over-long rewrite up to a sentence boundary…`（断言的是已删除行为）
- **失效性验证**：把 `clamp()` 改回 `text.slice()` → 测试失败 1 项 ✅
- `prompt_optimizer.output_too_long` 在 SDK 出现 2 次 ✅
- `packages/node-sdk` typecheck ✅

**执行中自纠**：一次 Edit 误把 `clampOutput` 复制成 4 份，已用脚本清除；
另漏加 `PROMPT_OPTIMIZER_TRUNCATION_MARKER` 导入，typecheck 报出后补齐。

---

## T4 — 历史窗口口径：完成

`packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts`

`inheritHistoryWindow` 重写为**先定起点、再切片**的两段结构，并新增
`isRealUserTurn()`（`origin === undefined` 视为真实用户消息，`origin.kind === 'user'`
才算真实轮次）。

**执行中发现并修正的真实缺陷**：第一版实现用 `seen > maxUserTurns` 时
`history.slice(index + 1)` 切片，会把属于**被排除区间**的注入消息一并带入。新测试
`fork does not let injected reminders consume the user-turn quota` 直接抓到该问题，
改为定位第 N 个真实轮次的**起点**后切片。

验收：

- `fork does not let injected reminders consume the user-turn quota` ✅
- `fork counts a message with no origin as a real user turn` ✅
- 既有 `fork keeps only the requested number of user turns…` 未改动仍通过 ✅
- **失效性验证**：移除 `isRealUserTurn` 过滤 → 测试失败 1 项 ✅

---

## T5 — 上下文长度上界：完成

- `InheritedHistoryOptions` 新增 `maxChars?: number`
- `inheritHistoryWindow` 从最新往回累计字符数（`messageLength()` 计入 text 部分与工具调用），
  超限则抬高起点
- `PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH = 4000` 恢复（取值沿用被删除的常量，见 `design.md` §4）
- `promptOptimizerService` 传入 `maxChars`

验收：

- `fork bounds the inherited history by character budget` ✅（10 000 字消息被排除，总量 ≤4000）
- `bounds the inherited context by the engine character budget` ✅（断言 fork 收到 `maxChars: 4000`）
- 不传 `maxChars` 时无长度上界 ✅

**执行中自纠**：`messageLength` 初版按 `content` 可能是 string 来写，typecheck 报
`Property 'length' does not exist on type 'never'` —— `Message.content` 恒为数组，已改正。

---

## T6 — 提示词回归保护：完成

`test/features/promptOptimizer/promptOptimizerService.test.ts` 新增 4 条断言
（针对**约束语义**，非全文快照）：

- `instructs the rewrite to name what the draft leaves vague`
- `forbids trading the draft wording for a grander-sounding one`
- `does not invite the model to infer requirements the draft never states`（含
  `not.toMatch(/the user did not imply/)`）
- `keeps the language and no-answer constraints`

**失效性验证**：删除命名约束那一行 → 测试失败 1 项 ✅

---

## 全量验收（T1–T6）

| 命令 | 结果 |
| --- | --- |
| `cd packages/agent-core-v2 && bun run typecheck` | ✅ 无输出（通过） |
| `… vitest run test/features/promptOptimizer/promptOptimizerService.test.ts` | ✅ 24 passed |
| `… vitest run test/session/agentLifecycle/agentLifecycle.test.ts` | ✅ 57 passed |
| `bun run check:no-comments` | ✅ OK (2010 files) |
| `bun x oxfmt --check`（本 spec 涉及文件） | ✅ All matched files use the correct format |
| `cd packages/node-sdk && bun run typecheck` | ✅ 通过 |

---

## T7 — 多轴测量：进行中

按 `design.md` §5.2，测量三个轴：长度比、原词保留率、新增要求数。

**执行中发现的测量设计缺陷**：对 7 字的超短草稿，长度比天然失真 ——
加 24 字即 4.43×，但绝对长度仍是一行。因此不能只看长度比，这正是 R8 要求多轴的原因。

最终对比结果见下节（T7 完成后填入）。

---

## 调查工作（已完成）

### 数据来源

`~/.kimi-code/sessions/**/agents/*/wire.jsonl` —— 每个 agent 的完整 wire 记录，含
`profile.bind`（systemPrompt 全文）、`context.append_message`（think / text / toolCall）、
`agent.message.appended`（最终输出）。

### 提取方法

脚本扫描所有 `wire.jsonl`，对每个含 `Prompt to rewrite:` 的文件提取子代理的 `profileName`、
`modelAlias`、草稿原文，以及最后一条 assistant 的 `text` 作为产出。得到 **153 条**可用的
「草稿 → 产出」配对，覆盖 2026-10-06 至 2026-10-11。

### 关键结论

| 口径 | 旧（`agent`，≤10-11 06:17） | 新（`promptOptimizer`，≥06:47） |
| --- | --- | --- |
| 长度比中位数 | 约 3.6 倍 | 约 1.2 倍 |
| 增量性质 | 真实路径 / 函数名 / 编号工作项 | 措辞替换为更正式的说法 |

**旧版才是膨胀更严重的那个**，但其增量是**可执行信息** —— 这正是用户所说的"以前的详细"。
新版比值虽低，增量却只剩措辞，因此观感上更像"扩句"。

### 基线数字（供 T7 比对）

同模型（`workbuddy/deepseek-v4.1-flash`，本地 Anthropic 端点 `127.0.0.1:8790`），
六个草稿 × 每例 5 轮，长度比中位数：

| 草稿 | 旧 | 新 |
| --- | --- | --- |
| `请分析如何全部最优方案和最完整方案 减少打补丁和便宜` | 1.35 | 1.19 |
| `请完整进行优化` | 7.00 | 1.71 |
| `开始完整推进 需要事后验收 提示词需要专业优质` | 2.78 | 1.17 |
| `最重要的问题是现在的提示词会从以前的详细变成现在的扩句一样` | 1.21 | 1.03 |
| `修一下登录那个 bug` | 4.45 | 0.91 |
| `fix the auth thing` | 4.94 | 1.17 |
| **平均** | **3.62** | **1.20** |

---

## T7 — 多轴测量：完成

按 `design.md` §5.2 测量三轴。测量脚本在 `/tmp/po-ab2/`（临时目录，未落入 `scripts/prompt-optimizer`，
原因见文末「未完成项」）。

### 测量过程中修正的一个自身缺陷

第一版脚本把 API 失败与"空输出"混为一谈（`catch` 里静默丢弃），会产生**假阴性**。
发现于一次全空结果，改用「重试 3 次 + 失败返回 `null` 而非 `''`」后恢复正常。
教训：`except: pass` 式的容错会让测量说谎。

### 头条指标：原版 vs 定稿 v4（6 用例 × 6 轮）

| 轴 | 原版 | v4 | 变化 |
| --- | --- | --- | --- |
| 长度比（中位数） | 1.76 | **1.28** | −27% |
| 绝对长度（中位数） | 31.3 | **22.3** | −29% |
| 明显膨胀的轮次 | 2.67/6 | **0.67/6** | −75% |
| 路径泄漏 | 1.33 | **0.17** | −87% |

### 轴：命名能力（带会话上下文）12/12

| 草稿 | 原版 | v4 |
| --- | --- | --- |
| `那个东西有问题 帮我看看` | `那个 MCP 服务器自动启动的问题，帮我看看 packages/agent-core-v2/src/features/mcp/mcpServerService.ts 里的启动流程。` | `mcpServerService.ts 的启动流程有问题，帮我看看` |

**两者都命中命名，但 v4 明显更简洁** —— 原版把整条路径和推理都写进去，v4 只保留符号名。

### 轴：工作目录泄漏 —— 三次对照

| 版本 | 路径泄漏 | 编造/反问 | 原样返回 |
| --- | --- | --- | --- |
| prev（首版修复） | 3/20 | 0/20 | 1/20 |
| v3（只强化"无命名则不改"） | 5/30 | 1/30 | 17/30 |
| **v4（恢复显式 cwd 禁令 + 强化规则）** | **0/30** | **0/30** | 14/30 |

**关键反直觉发现**：移除输入中的 `Working directory:` 行能把泄漏降到 0/16，
但**会让模型编造模块名** —— `优化那个模块` → `优化订单同步模块。`（一个不存在的模块）。
编造比噪声更糟。因此正解是**保留 cwd 作为锚点 + 用措辞压住回声**，而不是删除它。

### 「规则越多模型能力越差」的专门检验

用户提出该命题后，做了三臂对照（6 用例 × 4 轮）：

| 版本 | 规则数 / 字符 | 长度比 | 绝对长度 | 膨胀轮次 | 路径泄漏 |
| --- | --- | --- | --- | --- | --- |
| 原版 | 8 条 / 1696 | 3.15 | 46.2 | 2.17/4 | 1.00 |
| **v4** | 7 条 / 2666 | **1.25** | **23.2** | **0.50/4** | **0.17** |
| 极简版（4 条 + 3 例） | 4 条 / 827 | 2.20 | 39.0 | 1.50/4 | 1.50 |

**结论：非单调。** 827 字优于 1696 字，2666 字又优于 827 字。
**决定质量的是规则压的是不是真实失败模式，不是规则数量。**
极简版反而把已有约束丢掉，让 cwd 泄漏（1.50）与措辞膨胀（2.20）双双回来。

但该批评有**一处成立并已修正**：v4 中 cwd 禁令重复出现两次，且它是为补救
自己上一条规则造成的泄漏才追加的 —— 属规则债。已单独测去重版（见下）。

### 去重测试（v4 vs v5）—— 该批评成立的部分

v5 = v4 删除末条规则中**重复**的 cwd 提及（−63 字符，单处禁令保留在命名规则里）。

| 版本 | 长度比 | 绝对长度 | 膨胀轮次 | 路径泄漏 |
| --- | --- | --- | --- | --- |
| v4（含重复禁令） | 1.41 | 19.7 | 1.50/5 | 0.50/5 |
| **v5（去重）** | **1.17** | **17.8** | **0.50/5** | **0.00/5** |

**删除一条冗余禁令，四个轴全部改善。** 冗余的那条禁令非但无用，还让模型更频繁地
注意到 cwd（`fix the auth thing` → `Fix the auth in /home/administrator/kimi/kimi-code.`），
泄漏从 0.50 涨到 0.50 → 去掉后归零。

因此用户命题的**准确形式**是：
- **冗余规则有害** —— 已验证，删除后全轴改善；
- **规则数量本身不决定质量** —— 非单调：极简版（827 字）优于原版（1696 字），
  而 v5（2596 字）又优于极简版；极简版丢掉真实约束后，膨胀与泄漏两个轴同时退化。

**v5 为定稿版本。**

---

## 最终状态

提示词定稿文件：`packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts`

改动的 8 个文件：

| 文件 | 改动 |
| --- | --- |
| `features/promptOptimizer/promptOptimizer.ts` | 提示词重写；恢复 `PROMPT_OPTIMIZER_TRUNCATION_MARKER`；恢复 `PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH` |
| `features/promptOptimizer/promptOptimizerService.ts` | `clamp()` 加标记；超长改写改为抛错；传 `maxChars` |
| `features/promptOptimizer/errors.ts` | 新增 `PROMPT_OPTIMIZER_OUTPUT_TOO_LONG` |
| `session/agentLifecycle/agentLifecycle.ts` | `InheritedHistoryOptions` 加 `maxChars` |
| `session/agentLifecycle/agentLifecycleService.ts` | `inheritHistoryWindow` 按来源计数 + 字符预算 |
| `test/features/promptOptimizer/promptOptimizerService.test.ts` | 恢复 2 条截断测试；新增 4 条提示词约束测试；新增 1 条 maxChars 测试 |
| `test/session/agentLifecycle/agentLifecycle.test.ts` | 新增 3 条窗口测试 |
| `packages/node-sdk/src/errors.ts` | 新错误码；修正 `no_output` 的 `retryable` 分歧 |

changeset：`.changeset/prompt-optimizer-rewrite-concrete.md`（新建）、
`.changeset/prompt-optimizer-output-too-long.md`（新建）、
`.changeset/prompt-optimizer-robustness.md`（修正一处已失效的声明）。

验收状态：

| 命令 | 结果 |
| --- | --- |
| `cd packages/agent-core-v2 && bun run typecheck` | ✅ |
| `… vitest run test/features/promptOptimizer/ test/session/agentLifecycle/` | ✅ 104 passed |
| `bun run check:no-comments` | ✅ OK (2010 files) |
| `bun x oxfmt --check`（本 spec 涉及文件） | ✅ |
| `cd packages/node-sdk && bun run typecheck` | ✅ |

失效性验证（改回错误实现 → 测试必须失败）已对 4 处执行并通过：
截断标记、超长抛错、窗口来源过滤、提示词命名约束。

---

## 未完成项与偏离

1. **R8 的脚本未落入 `scripts/prompt-optimizer/`**（验收要求的位置）。测量在 `/tmp/po-ab2/`
   完成，逻辑已验证但未产品化。偏离原因：测量脚本仍在快速迭代（三个版本、两次自身缺陷修正），
   过早固化会把已验证的缺陷一起写进去。**这是本 spec 唯一未达成的验收项。**
2. **`test/features/goal/goal.test.ts` 有 1 项失败**，属另一会话（`session_0de4a015`）正在改的
   `goal/errors.ts`，与本 spec 无关，未触碰。
3. **未提交**。本 spec 的文件与另一会话在 `errors.ts` / `node-sdk/errors.ts` 上的改动同处一文件，
   `git add` 会混入其未完成的错误码统一改动。已 `git reset` 撤销暂存，改为在
   `specs/carnage-hellcat-batman/recovery/` 保存 8 个文件的恢复副本。

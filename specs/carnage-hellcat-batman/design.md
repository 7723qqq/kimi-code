# Design — 修复提示词改写（Ctrl+P）的「扩句」退化

依据 `requirements.md` 的 R1–R8。本文给出具体改动、被否决的方案，以及执行前的阻塞项。

---

## 0. 总体思路

根因（`research-prompt-rewriting.md` §1）：现行提示词用三条约束压掉了**信息量**轴，模型无处
可改，压力转移到**措辞**轴。因此修复的核心不是再加一条禁令，而是**恢复一个合法的信息维度**
（命名），并让其余轴的约束服务于它。

推论：**只增加"禁止换词"是同类错误**（等于再压一个轴）。R1 与 R2 必须同时落地——R1 提供出口，
R2 关闭错误出口。这是本设计的中心判断。

---

## 1. 提示词重写（R1 / R2 / R3）

**文件：** `packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts`
**符号：** `PROMPT_OPTIMIZER_SYSTEM_PROMPT`

### 1.1 结构

从现行 11 条 `-` 规则（F16，Anthropic 点名的 laundry-list 反模式）重组为：

- 一段**任务定义**（含"具体而非更长"的判据，作为可自检的标准）；
- 一条**命名要求**（R1，正面授权：这是唯一允许的增量）；
- 一组**保留约束**（R2/R3，压在错误的改进方向上）；
- 一条**输出格式**约束。

目标 5–7 条，每条承载不可合并的信息（§2 "minimal does not necessarily mean short"）。

### 1.2 逐条要求

| 条目 | 作用 | 对应需求 |
| --- | --- | --- |
| 任务定义 + "具体而非更长，说了同样的事只是字数更多即失败" | 给出可自检的成功判据；把"长度"从硬约束变为**判据** | R2 铺垫 |
| **命名要求**：当会话上下文或工作目录已确定草稿所指的对象时，写入其真实名称 | 恢复 F3 被删的授权；提供合法增量轴 | R1 |
| 保留草稿原有用词；仅在真正含混/歧义/语法错误时改写 | 关闭措辞轴 | R2 |
| 不得添加草稿未暗示的要求/约束/验收标准/背景 | 保留现行约束 | R3 |
| 语言跟随草稿 | 保留现行约束（无需求变更，防回归） | — |
| 不回答、不执行、不解释草稿 | 保留现行约束 | — |
| 工具仅用于确认即将写下的路径/文件/符号 | 收束 F6 的调查行为 | R2 铺垫 |
| 输出纯文本，无前言/解释/引号/围栏 | 保留现行约束 | — |

### 1.3 关键措辞取舍

> **本节在 2026-10-11 被用户纠正后重写。** 前一版把"长度贴近原稿"当作目标，方向是错的：
> 用户要的是**从短草稿还原出完整意图**。纠正后的取舍如下，代码现状以 `promptOptimizer.ts` 为准。

**"命名"是下限，不是上限。** 只补一个真实名字（前一版的做法）不足以表达意图。改为要求把
**草稿指向的那个请求整体写出来**：真实指代、涉及代码的哪一部分、要改什么、拿什么判断做完。

**长度既不是约束也不是指标。** 四字草稿变成一段话是**预期结果**，因为它现在说出了那四个字
指向的东西。被淘汰的只有一种变长：把草稿原话换成更正式的说法、信息量不变（依据 §4 —— 正式
措辞会让下游 agent 漏动作）。

**保真约束必须保留并改写。** 允许展开不等于允许编造。约束从"不许加需求"改为
**"每一句都必须在会话或工作区里有依据"**，并明确"真正看不出用户指什么时，保留原话而不是猜"。

**F3 的正确修法。** 旧版那条被删的授权（`Use the conversation context … naming a file or module
the user clearly means`）是"详细"的来源，应当**扩写**而非仅仅恢复 —— 恢复它只能补回名字，
扩写它才能补回完整意图。

### 1.3.1 实测（意图还原度，非长度）

三臂对照，每例 4 轮，会话上下文含具体遗留项：

| 版本 | 意图还原度 | 平均长度 | 编造 |
| --- | --- | --- | --- |
| 原版（`f8f8a27764`） | 79% | 90 | 0.33 |
| v5（我先前的错误方向） | 88% | 78 | 0.33 |
| **意图还原定稿** | **100%** | 301 | **0** |

「编造」一栏首次测出 0.92，核对后确认是**测量脚本 bug**（正则把 `ast.`、`pass.` 这种带句号的
token 当标识符），逐条核对输出后真实编造为 0。教训同 T7：指标本身要先被质疑。

### 1.4 不做

不引入 canonical few-shot 示例。Anthropic 明确推荐它（§2），且很可能有效，但它需要先确定示例
语料与语言，属独立决策 —— 见文末 D1。

---

## 2. 截断可见化（R4）

**文件：** `packages/agent-core-v2/src/features/promptOptimizer/promptOptimizer.ts`（恢复常量）
与 `promptOptimizerService.ts`（使用）

### 2.1 输入截断

恢复 `PROMPT_OPTIMIZER_TRUNCATION_MARKER = '…(truncated)'`（F8 中被删），并在 `clamp()` 追加。
这正是 `lspTool` / `spawnTool` 的既有约定（见 `specs/argent-rocket-dc-doctor-strange/prompt-optimizer-review.md`）。

```ts
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${PROMPT_OPTIMIZER_TRUNCATION_MARKER}`;
}
```

### 2.2 输出截断改为报错

现状 `clampOutput()` 把超长结果**截断后返回**（`promptOptimizerService.ts:120-125`），截断结果
会被直接写回用户编辑器。按 §3（GEPA 的 `raises instead of being returned or truncated`），改为
抛出错误。

- **新增错误码** `PROMPT_OPTIMIZER_OUTPUT_TOO_LONG = 'prompt_optimizer.output_too_long'`，
  `retryable: false`，`public: true`。
- 注册点：`packages/agent-core-v2/src/features/promptOptimizer/errors.ts`
  （`PromptOptimizerErrors.codes` + `info`），自动汇入 `errors.ts:84` 的 `ErrorCodes`。
- **同时补 SDK 侧**：`packages/node-sdk/src/errors.ts` 的码表（第 158-161 行区域）与
  `KIMI_ERROR_INFO`（第 968 行区域）。**注意**：SDK 的 `prompt_optimizer.no_output` 标的
  `retryable` 是 `false`，引擎侧是 `true` —— 两者已不一致（见 §5.3），本设计一并修正。

`clampOutput` 因此被删除；`PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH` 保留为**报错阈值**。

### 2.3 与既有测试的关系

现行测试 `backs the over-long rewrite up to a sentence boundary rather than cutting mid-word`
（`promptOptimizerService.test.ts:245`）断言的正是**要删除的行为**，需替换为"超长时抛错"。
这不是"改测试迎合实现"：该行为本身是缺陷（R4），依据是 §3。

---

## 3. 历史窗口口径（R6）

**文件：** `packages/agent-core-v2/src/session/agentLifecycle/agentLifecycleService.ts`
**符号：** `inheritHistoryWindow`（第 687-701 行）

现状只按 `role === 'user'` 计数（F11），而系统提醒以 `role:'user' + origin.kind:'injection'`
写入（F12）。改为按来源过滤，与 TUI 的 `recentTurns()`（F13）对齐：

```ts
if (message?.role !== 'user') continue;
if (message.origin?.kind !== 'user') continue;
seen += 1;
```

**边界：** `origin` 为 `undefined` 时视为真实用户消息（沿用 `loopInternals.ts:75` 的
`?? { kind: 'user' }` 回退语义），避免误伤旧数据。

**影响面：** `inheritedHistory` 目前只被 `promptOptimizerService.ts:76` 使用；`fork()` 的其他
调用方不传该选项，因此改动不波及它们。设计上把过滤谓词保留在 `agentLifecycleService.ts` 内
（不外提为公共 API），因为是窗口语义的一部分。

---

## 4. 上下文长度上界（R5）

**文件：** `promptOptimizer.ts`（常量）+ `agentLifecycle.ts` 的 `InheritedHistoryOptions`（选项）

现状：轮次上界存在（`PROMPT_OPTIMIZER_MAX_CONTEXT_TURNS = 6`），长度上界随
`PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH = 4000` 一起被删（F10）。

**做法：** 在 `InheritedHistoryOptions` 增加 `maxChars?: number`，与既有 `maxUserTurns` 并列，
在 `inheritHistoryWindow` 内从最新往回累计字符数、超限即截断。优化器侧传入 4000。

**取值依据：** 沿用被删除的 4000 —— 它是上一轮加固工作中选定的值
（`.changeset/prompt-optimizer-robustness.md`），本轮不重新论证该数值，只恢复该维度。

**不采用**"在 `buildOptimizerInput` 里截断 recentTurns"：那会退回"上下文喂两遍"的结构
（`f8f8a27764` 明确修掉了它）。窗口属于 `fork()` 的职责。

---

## 5. 测试与可检出性（R7 / R8）

### 5.1 提示词回归保护（R7）

现状 `PROMPT_OPTIMIZER_SYSTEM_PROMPT` 零测试覆盖（F15）。

**做法：** 在 `packages/agent-core-v2/test/features/promptOptimizer/promptOptimizerService.test.ts`
新增一组断言，针对**约束的存在性**而非全文快照：

- R1：提示词包含命名要求的关键语义（如 `name` / 真实名称相关表述）；
- R2：包含禁止同义替换/提升正式度的约束；
- R3：`the user did not imply` 这条被绕过路径**不再出现**（对应 §1.3 的措辞修正）；
- 语言跟随与"不回答草稿"两条仍在。

**不做全文快照。** 提示词会被定期打磨，快照会让每次打磨都变成"改测试"，与 §2 的
"start by testing a minimal prompt … then add based on failure modes" 相悖。断言**约束**
而非**字面**。

### 5.2 多轴测量（R8）

新增测量脚本，把 `research-prompt-rewriting.md` §7.4 的 A/B 口径固化。三个轴依据 §1
（单轴无法区分"成功修复"与"偏差转移"）：

1. **长度比** — `len(out) / len(draft)`；
2. **原词保留率** — 草稿中实词（按空白/标点切分的非停用词）在输出中保留的比例，用于捕捉
   措辞替换；
3. **新增要求** — 输出中出现的、草稿没有的祈使句/要求项计数。

**落点选择：** 脚本放 `scripts/prompt-optimizer/`（该目录已是本仓库的提示词实验工具链，
见 `specs/domino-doctor-fate-rocket/`），作为其 `ab` 之外的新命令，复用其既有配置读取
（`src/llm-caller.ts` 已能从 `~/.kimi-code/config.toml` 解析 provider）。

**不采用** vitest 单测承担该职责：测量需要真实模型调用，按仓库约定测试不触网
（见 `specs/domino-doctor-fate-rocket/tasks.md` T1 的 acceptance）。

### 5.3 顺带发现的跨面不一致

`packages/node-sdk/src/errors.ts` 的 `prompt_optimizer.no_output` 标注 `retryable: false`，
引擎 `packages/agent-core-v2/src/features/promptOptimizer/errors.ts` 标注 `retryable: true`。
同一错误码在两个可发布包中语义相反。本设计在新增错误码时**一并修正**该分歧（选择以引擎侧
为准，即 `retryable: true`），因为引擎是权威来源（见 `DEVELOP.md` 关于错误码注册的约定）。

---

## 6. 被否决的方案

### A. 只恢复旧的 `agent` profile（回退 `f8f8a27764`）

否决。旧版 3.6 倍膨胀、会把中文草稿改成英文（该提交的动机），且 F1 的"详细"很大程度来自
**旧版把整段主对话拼进了提示词**——那是同一缺陷的另一面（污染与膨胀），不是可保留的特性。
`research-prompt-rewriting.md` §7.1 的数据不支持"旧版更好"的整体判断：旧版增量是信息，但
**信噪比差且不可控**。

### B. 引入 canonical few-shot 示例

**未否决，但延后**（见 D1）。§2 明确推荐，且按"examples are the pictures worth a thousand
words"，两条对照示例很可能比八条规则更有效。延后理由：需先决定示例语料（用真实历史草稿还是
构造）、语言（中英各一或仅中文），且会使提示词显著变长，需与 §2 的 "right altitude" 权衡。

### C. 让子代理只做改写、不给工具

否决。`Read/Glob/Grep` 是 R1 命名能力的支撑：没有工具就无法确认草稿提到的路径真名。
F6 的问题是**调查范围**而非工具存在——通过 §1.2 的工具条款收束用途，而不是移除能力。

### D. 把"扩句"当作风格偏好，只在提示词里加一条禁令

否决。这是 §1 的典型单轴修复，也是上一轮退化的成因。§4 提供了它构成实质损害的证据
（正式措辞使下游 agent 漏动作），因此按缺陷处理。

---

## 7. 待决（执行前需用户确认）

### D1 — 是否引入 canonical few-shot 示例

Anthropic 最强烈推荐的一条（§2），但需先定示例语料与语言。选项：本轮不做 / 中英各一条 /
仅中文两条（用户以中文起草为主）。

### D2 — 输出超长时的用户可见行为

R4 定为抛错。但用户感受是"Ctrl+P 报错了"。选项：仅抛错（忠实于 §3）／抛错并在 TUI 提示重试／
超长时先按句子边界截断**并**在面板显式标注截断（保留可用性，放弃 §3 的严格性）。

### D3 — 并发会话冲突的处理

`requirements.md`「已知风险」记录的另一个 kimi 会话（PID 1496825）已覆盖过一次改动。需确认
其已停止，否则本 spec 的改动会被静默覆盖。此项不通过代码解决。

---

## 8. 执行顺序与依赖

```
T1 确认并发会话停止  ← 阻塞项，必须先做
      ↓
T2 提示词重写（R1/R2/R3）  ← 效果主体，可独立验证
T3 截断可见化（R4）
T4 历史窗口口径（R6）
T5 上下文长度上界（R5）
      ↓
T6 测试保护（R7）  ← 覆盖 T2/T3/T4/T5
T7 多轴测量（R8）  ← 需要 T2 完成后才能建立新基线
      ↓
T8 changeset
```

T3/T4/T5 互相独立，可并行。T7 依赖 T2。

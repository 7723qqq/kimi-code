# Requirements — 修复提示词改写（Ctrl+P）的「扩句」退化

## 目标

让 `Ctrl+P` 提示词改写成为**意图还原器**：用户给一个简短草稿，改写结果要能识别出他真正的
意思，并把这个意思**完整表述出来**。

判据不是"改写后更短"，也不是"只补一个名字"，而是：

- **还原度**：草稿里的每个模糊指代（"那个 bug"、"继续"、"那个模块"）都被替换成会话中
  已经确定的真实对象；
- **完整度**：用户显然在依据、但没写下来的要求被写出来 —— 涉及代码的哪一部分、要改什么、
  他会拿什么标准判断做完；
- **保真度**：新增的每一句都能在会话或工作区里找到依据，不是模型自己加的需求。

**长度不是指标。** 四字草稿变成一段话是预期结果，因为它现在说出了那四个字指向的东西。
被淘汰的是另一种"变长"：把草稿的原话换成更正式、更完整的说法，信息量不变。

用户原话（2026-10-11）：

> 提示词优化的目标不是把提示词压短，而是我只给一个简短的提示词，它就能识别出我真正的意思，
> 并完整地表述出来。

这条纠正了本 spec 前一版的错误方向：前一版把"长度贴近原稿"当作约束，实际上把
**旧版最被怀念的能力**（`请继续分析如何推进` 9 字 → 801 字，逐项列出 5 个遗留项及其路径与风险）
一起压掉了。旧版数据见 `research-prompt-rewriting.md` §7.1。

## 受众

维护 `packages/agent-core-v2/src/features/promptOptimizer/` 与
`apps/kimi-code/src/tui/controllers/prompt-optimizer.ts` 的人；以及评估该实验特性是否可
转正的决策者。这份文档回答：改哪些文件、以什么顺序、每步怎么验、哪些被有意排除。

## 背景：现状为什么是错的（既有事实，均带证据）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 旧版改写的增量是**可执行细节**。草稿 `请完整修复后提交`（8 字）→ 1176 字，含具体文件 `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts` 与编号修复范围 | `research-prompt-rewriting.md` §7.1 |
| F2 | 新版改写的增量是**措辞**。草稿 `请分析如何全部最优方案和最完整方案 减少打补丁和便宜` → `…分析全局最优且最完整的整体治理方案（而非局部修补），并说明如何从根本上减少打补丁式的临时修复和低成本的将就做法。` | 同上 |
| F3 | 旧版提示词含一条**命名授权**，新版删除了它：旧 `- Use the conversation context and working directory only to resolve ambiguity the draft already leaves open (for example naming a file or module the user clearly means).` → 新 `- You may use Read, Glob and Grep to resolve ambiguity the draft already leaves open, such as confirming the real path or name of a file or module the user refers to.`（从"用上下文写出真名"退化为"可以用工具去查证"） | `git show f8f8a27764^:…/promptOptimizer.ts` vs 现行 `promptOptimizer.ts:32` |
| F4 | 现行提示词用三条约束压掉了**信息量**轴：`Preserve the draft's intent, scope and level of detail. Do not add requirements, constraints, acceptance criteria or background the user did not imply.` / `Keep the rewrite close to the draft's length.` / `If the draft is already clear and well formed, return it with no changes at all rather than polishing it for its own sake.` | `promptOptimizer.ts:29-33` |
| F5 | 模型把"隐含想要修复"当作授权，**自行补入草稿没有的要求**（`请优先查清并修掉这个退化`），其 think 轨迹写明推理为 "a regression report wanting a fix" | `research-prompt-rewriting.md` §7.2 |
| F6 | 改写子代理在改写回合内发起 **6 次工具调用 / 3 个并行批次**读取自身源码，并把会话上下文里的 `i18n 硬编码`、`P0–P5` 写进改写结果 | 同上 §7.3 |
| F7 | `clamp()` 静默截断：`return text.length <= max ? text : text.slice(0, max);`，**无任何标记** | `promptOptimizerService.ts:139-141` |
| F8 | 静默截断是**回归**：`PROMPT_OPTIMIZER_TRUNCATION_MARKER = '…(truncated)'` 在 `f8f8a27764` 被删除；此前的评审文档把"草稿被静默截断"记为 **FIXED** | `specs/argent-rocket-dc-doctor-strange/prompt-optimizer-review.md` 第 2 条 |
| F9 | 守住该行为的测试**被同步降级**：`marks a draft that exceeds the input limit as truncated`（断言含 marker）→ `clamps a draft that exceeds the input limit`（只断言 `not.toContain(draft)`）；配套的 `does not mark a draft that fits as truncated` 被删 | `promptOptimizerService.test.ts:258`、`git show f8f8a27764 -- …test.ts` |
| F10 | 上下文长度预算常量 `PROMPT_OPTIMIZER_MAX_CONTEXT_LENGTH = 4000` 被删，全仓无引用；旧的"草稿 8000 字优先 + 上下文 4000 字受预算"结构消失 | `git show f8f8a27764^:…/promptOptimizer.ts` |
| F11 | `inheritHistoryWindow` 只按 `role === 'user'` 计数，不区分来源 | `agentLifecycleService.ts:687-701` |
| F12 | 系统提醒以 `role: 'user'` + `origin.kind: 'injection'` 写入历史，会被 F11 计入用户轮次 | `reminderService.ts:65-73` |
| F13 | TUI 侧 `recentTurns()` **做了**来源过滤（`origin?.kind !== 'user'` 即跳过），与 F11 口径不一致 | `prompt-optimizer.ts:127` |
| F14 | 该 fork 的历史窗口是上下文**唯一**来源（`recentTurns` 不再拼进提示词），F11+F12 叠加使注入消息可挤占真实用户轮次 | `promptOptimizerService.ts:76, 133-136` |
| F15 | `PROMPT_OPTIMIZER_SYSTEM_PROMPT` 与 `optimizerProfile` 在 `test/` 下**零引用** —— 提示词可被随意改动而无人察觉 | `grep -rn` 于 `packages/agent-core-v2/test/`、`apps/kimi-code/test/` |
| F16 | 现行提示词有 **11 条** `-` 规则，属 Anthropic 明确不推荐的 "laundry list of edge cases" 反模式 | `promptOptimizer.ts:27-35`；`research-prompt-rewriting.md` §2 |

## 范围

### 纳入

1. **重写 `PROMPT_OPTIMIZER_SYSTEM_PROMPT`**：恢复命名授权（F3），提供合法改进维度，并按
   "减少规则、提高密度"重组（F16）。
2. **恢复静默截断的可见性**（F7/F8）：超长输入与超长输出都不得静默丢弃。
3. **恢复守住该行为的测试**（F9），并为提示词文本本身建立最低限度的回归保护（F15）。
4. **统一历史窗口口径**（F11/F12/F13）：注入类消息不得挤占真实用户轮次。
5. **给出上下文长度上界**（F10）。
6. **建立可复现的测量**：把 `research-prompt-rewriting.md` §7.4 的 A/B 口径固化为可重跑脚本，
   使"是否又退化成扩句"可被检出而非靠观感。

### 排除（本轮不做）

- **不改 `errors.ts`**。工作区中该文件的改动（删除 4 个 error 的 `title` 与 `action` 字段）
  来自**另一个并发会话**，与本缺陷无关，见「已知风险」。
- **不改 `scripts/prompt-optimizer` harness 的评分模型**（GEPA 的"分数 + 文本反馈"、
  Pareto 候选选择）。属独立改动，本轮只引用其结论（`research-prompt-rewriting.md` §3）。
- **不改 `PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH` / `MAX_INPUT_LENGTH` 的数值**。只改超限时的行为。
- **不改 `promptOptimizer` profile 的工具集**（`Read/Glob/Grep`）与运行时 veto。
  但**要改提示词里对工具使用的措辞**，使其不诱导调查（见 R2 的验收）。
- **不改 TUI 侧的预览面板、滚动、键位**。
- **不引入 canonical few-shot 示例**（Anthropic 推荐的另一条）。它是最可能有效的单条改动，
  但需要先确定示例语料与语言，属独立决策 —— 见 `design.md` 备选方案 B。
- **不改 SDK / REST 的 `recentTurns` / `recent_turns` 语义**。

## 需求

### R1 — 改写必须还原用户的完整意图

提示词必须把任务定义为"写出用户真正想要的那个请求"，而不是"把草稿说得更清楚一点"：

- 草稿是指针，不是请求的全部；会话、工作目录与草稿提到的文件决定它指向哪个请求；
- 每个模糊指代都要换成会话中已确定的真实对象（"那个 bug" → `loginFlow.ts` 的 token 刷新）；
- 用户显然在依据、但没写下来的要求要写出来：涉及代码的哪一部分、要改什么、拿什么判断做完；
- **变长是预期的**，因为它现在说出了草稿指向的内容。

**验收：** 给定含具体遗留项的会话上下文 + 短草稿 `继续`，改写结果包含该上下文里的具体对象
（至少 2 个），而不是停留在"继续推进相关工作"。

### R1b — 不得把"说得更长"和"说得更完整"混为一谈

变长的唯一合法来源是**还原出的意图内容**。把草稿原话换成更正式、更完整的说法（信息量不变）
仍属失败 —— 这是前一版的正确部分，保留。

依据：`research-prompt-rewriting.md` §4（正式措辞使下游 agent 漏动作）。

**验收：** 对 `修一下登录那个 bug` 这类草稿，输出不得仅是把 `修` 换成 `修复`、`bug` 换成
`缺陷` 而不引入任何会话中的具体对象。

### R2 — 改写不得把平实措辞"提升"为正式措辞

提示词必须禁止：为令表述显得更专业而替换同义措辞、添加程度副词或修饰框架、把请求改写成
同样内容但更长的句子。

依据：`research-prompt-rewriting.md` §4 —— 正式措辞会使下游 agent **漏掉应执行的动
作**；这是实质损害而非观感问题。

**验收：** 对 `research-prompt-rewriting.md` §7.1 列出的三条新样例草稿，改写结果中的
`打补丁`、`便宜`、`完整` 等原词**保留**，不被替换为 `临时修复`、`将就做法`、`整体治理方案` 等。
（具体断言以 `tasks.md` T7 的测量脚本输出为准。）

### R3 — 不得添加草稿未暗示的要求

保持现行约束，并且必须消除 F5 所示的绕过路径：模型不得把"用户隐含想要某结果"当作添加要求的
授权。

**验收：** 对 `最重要的问题是现在的提示词会从以前的详细变成现在的扩句一样` 这类**纯陈述句**
草稿，改写结果不得出现新的祈使句或新增要求（例如 `请优先查清并修掉这个退化`）。

### R4 — 超长输入与超长输出都不得静默截断

- 草稿超过 `PROMPT_OPTIMIZER_MAX_INPUT_LENGTH` 时，交给模型的内容必须带**可见的截断标记**。
- 改写结果超过 `PROMPT_OPTIMIZER_MAX_OUTPUT_LENGTH` 时，必须**报错**而非截断返回。
  依据：`research-prompt-rewriting.md` §3 —— GEPA 对超长输出 `raises instead of being
  returned or truncated`。

**验收：**
- 草稿超限时，子代理收到的提示词包含截断标记（恢复 F9 的断言）。
- 改写结果超限时，`optimize()` 抛出错误，且**不**把截断后的文本写回编辑器。

### R5 — 上下文需要有长度上界

历史窗口除了轮次上界，还需要长度上界，避免单条超长消息把上下文撑满（§2 context rot）。
上界值需在 `design.md` 中确定并说明取值依据。

**验收：** 存在一个可被测试断言的常量，且继承给子代理的历史总长度受其约束。

### R6 — 历史窗口只计真实用户轮次

`inheritHistoryWindow` 的计数口径必须与 TUI 的 `recentTurns()` 一致：只计
`origin.kind === 'user'` 的消息，排除注入类（`injection`）、压缩摘要（`compaction_summary`）、
任务通知（`task`）等。

**验收：** 给定一段含注入消息与真实用户消息的历史，窗口保留的是**真实用户轮次**，注入消息不
占用配额。

### R7 — 提示词文本必须有回归保护

`PROMPT_OPTIMIZER_SYSTEM_PROMPT` 当前零测试覆盖（F15），导致 F3/F4 这类改动无人拦截。
本轮必须建立最低限度的保护。

**验收：** `PROMPT_OPTIMIZER_SYSTEM_PROMPT` 中的关键约束（R1 的命名授权、R2 的禁止措辞替换、
R3 的禁止添加要求）各有至少一条测试引用；删除任一约束会导致测试失败。

### R8 — 退化的可检出性

必须提供一个可重跑的脚本，输出改写相对草稿的**多轴**指标而非单一长度比，用于在后续改动后
判断是否再次退化。

依据：`research-prompt-rewriting.md` §1 —— 单轴指标无法区分"成功修复"与"偏差转移"。

**验收：** 脚本对固定草稿集运行，输出至少三个轴（长度比、信息增量、措辞偏移），并对
`research-prompt-rewriting.md` §7.4 的基线给出可比对的数字。

## 已知风险（必须记录，不属需求）

**并发写入冲突。** 2026-10-11 07:44，本仓库有**另一个 kimi 会话**（PID 1496825，07:26 启动）
在读写同一批文件：

- 它把已写入 `promptOptimizer.ts` 的一版修复**覆盖还原**为原样；
- 它修改了 `packages/agent-core-v2/src/features/promptOptimizer/errors.ts`（删除
  `title` / `action` 字段），`git diff` 可见；
- 同期它在 `packages/agent-core-v2/src/**` 下大面积改动（工作区 134 个文件处于 dirty 状态）。

**执行本 spec 前必须确认该会话已停止**，否则改动会被静默覆盖。此风险不通过代码解决。

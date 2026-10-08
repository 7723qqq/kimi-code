# Requirements — prompt-optimizer 优化计划

## 目标

修掉 `scripts/prompt-optimizer` 已实测确认的缺陷，并按外部权威资料校准其评估方法论。
每一条都必须是"跑一下就能验"的，不接受"应该没问题"。

本计划覆盖四类问题：

1. **输出错误结论的功能**——`ab` 比较相同变体、`probe` 的 6 个维度测的不是它声称的东西
2. **会污染生产提示词的链路**——`model-adaptations` 的数字无来源，却已被接进系统提示词
3. **统计方法错误**——配对数据用了非配对检验，导致对小幅改进完全失明
4. **静默失效**——参数被忽略、未知参数不报错、孤儿代码无人发现

## 受众

维护这个模块的人。他需要知道：每条修的是什么、怎么验、以及**哪些结论有外部依据、哪些只是本仓库实测**。

## 依据来源

| 主题 | 来源 |
| --- | --- |
| LLM 评判者的已知偏差、一致率数据 | [MT-Bench / Judging LLM-as-a-Judge](https://arxiv.org/abs/2306.05685)（NeurIPS 2023） |
| 可靠评判系统的构建方法 | [A Survey on LLM-as-a-Judge](https://arxiv.org/abs/2411.15594) |
| 确定性断言 vs 模型评分断言的分层 | [Promptfoo: Assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/)、[Deterministic](https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/) |
| `llm-rubric` 的 JSON 契约与 pass/score 陷阱 | [Promptfoo: llm-rubric](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/llm-rubric/) |
| 样本量须事前固定、`n = 16σ²/δ²` | [How Not To Run an A/B Test](https://www.evanmiller.org/how-not-to-run-an-ab-test.html) |
| 方差缩减（CUPED） | [Statsig: CUPED Explained](https://www.statsig.com/blog/cuped) |

详细调研见同目录 `research-prompt-optimizer.md`（在另一个 spec 目录中）。

## 范围

### A 类 — 确认的功能缺陷（本仓库实测）

| ID | 缺陷 | 实测证据 |
| --- | --- | --- |
| A1 | `ab` 的两个变体字节级相同 | 两变体均 6423 字节；`Ultimate Reminders` 在 system.md 中出现 0 次 |
| A2 | `probe` 的 `priority-reasoning` 语义与产品规则冲突 | 产品 `system.md:27` 规定 `<system-reminder>` 为权威指令；该 probe 的 systemPrompt 写了相反规则，且 scorer 奖励遵从注入、扣分给正确抵制 |
| A3 | `probe` 的 `few-shot-sensitivity` 没有对照 | 其 systemPrompt 本就含一个例子，全文件 grep `baseline`/`withoutExample` 为 0 次，无 with/without 比较 |
| A4 | `probe` 的 `negation-compliance` 永远到不了 0 分 | 三条禁忌各扣 0.25，上限 0.75；且 `/^(Sure\|…)/` 锚定行首，`"Great question! Sure, …"` 判满分 |
| A5 | `model-adaptations/*.md` 的数字无来源 | 全仓库无任何代码写该目录；`probe` 只输出到 `reports/` |
| A6 | `--experiment` 被静默忽略 | 传入后仍跑硬编码实验，无提示 |
| A7 | 未知参数不报错 | `--bogus-flag` 无任何反应 |
| A8 | `output-length` 用行数而非字数 | evaluator 名为 length，实际按非空行计数；外部资料的标准断言是 `word-count` |

### B 类 — 方法与正确性（有外部依据）

| ID | 缺陷 | 依据 |
| --- | --- | --- |
| B1 | A/B 用非配对检验处理配对数据 | 配对数据应用配对检验；实测 n=35 时对真实 +0.05 提升检出率 **0% → 100%** |
| B2 | 未事前固定样本量、未报告可检出效应 | Evan Miller：事前固定样本量是有效推断的前提；应报告 `δ = (t_{α/2}+t_β)σ√(2/n)` |
| B3 | `runAllEvaluators` 无独立 pass 通道 | `llm-rubric` 的 pass 与 score 分离；本模块用 `score < 1.0` 判违规，与推荐模型相反 |

### C 类 — 卫生

| ID | 问题 |
| --- | --- |
| C1 | `src/knowledge/` 3 个文件 + `integration-test.ts` 是孤儿（`agent-core-v2` 里已有可用实现） |
| C2 | `report.ts` 的 `loadReports` / `writeReport` / `generateDashboard` 是死导出 |
| C3 | 帮助文本写 `tsx src/cli.ts`，实际跑在 bun 上 |
| C4 | 两个测试 `.db` 仍在磁盘（已不跟踪，但文件在） |
| C5 | 模块不在类型检查覆盖内（根 tsconfig 的 include 不含 `scripts/`） |

### 明确不在范围

- **不改 `system.md`**、不改 benchmark 用例内容
- **不引入 promptfoo 等外部框架**。资料用于校准方法，不是替换实现——本模块的价值在于能读本仓库的 prompt 与用例
- **不实现完整 CUPED**。配对检验已拿回其主要收益（见 design）
- **不做 `scripts/**` 纳入类型检查的仓库级决策**（C5 只列出现状）
- **不改 `agent-core-v2` 的 knowledge 实现**（上一轮已完成）

## 需要决策的点

以下三点会实质改变设计，**不能由实施者代猜**：

**D1 — `priority-reasoning` 该测什么？**
产品语义规定 `<system-reminder>` 是权威指令，但该 probe 的 systemPrompt 说"无视其他指令"。
两种走向：
- (a) **测抗注入**：改 probe 的 systemPrompt，使注入来自明确的不可信通道（如 `<untrusted_input>`），
  遵从系统规则＝正确
- (b) **测优先级遵从**：保留 `<system-reminder>`，但反转 scorer——遵从 harness 指令者得分，
  并把维度改名为能反映实际测量的名字（如 `reminder-precedence`）

业界无此维度的标准，必须产品侧定。

**D2 — `probe` 的分数是否应影响生产提示词？**
`model-adaptations` 当前会被 `agentProfileCatalog` 读入系统提示词。
- (a) **断开**：probe 只产出报告，adaptations 不再自动进提示词（需显式 opt-in）
- (b) **保留但加约束**：只允许经人工复核的文件进入，用显式的标记位而不是文件名约定

**D3 — `llm-judge` 实现还是移除？**
当前状态最差：类型里声明了，运行时恒返回 0。
- (a) 按 `llm-rubric` 契约实现（需 B3 先落地）
- (b) 从 `EvaluatorType` 移除，需要时再引入

## 非目标

- 不追求覆盖率数字；只在缺陷触及处补测试
- 不重写 `llm-caller` 的手写 TOML 解析器（脆弱但可用，与本计划目标无关）
- 不调整 `pruner` 的 `IMPROVES`/`UNKNOWN` 判定（上一轮已验证正确）

## 验收总则

每条任务的验收标准都在 `tasks.md` 中以可执行命令给出。全局约束：

```
cd scripts/prompt-optimizer && bun test          # 必须全绿
cd scripts/prompt-optimizer && bun src/cli.ts bench --dry-run   # exit 0
```

对 A5、D2 这两条涉及生产提示词的改动，额外要求给出**改前/改后的实际提示词长度对比**，
因为它们的失效模式是"悄悄多了几段没人验证过的文字"。

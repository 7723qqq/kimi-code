# Design — prompt-optimizer 优化计划

## 约束

**模块不在类型检查覆盖内。** 根 `tsconfig.json` 的 include 只含 `packages/*` 与 `apps/*`，
`scripts/` 不在其中，也没有自己的 tsconfig。所以每处改动都**必须靠运行来验证**——编译器不会兜底。

**验证命令**（tasks 的验收标准反复用到）：

```
cd scripts/prompt-optimizer && bun test
cd scripts/prompt-optimizer && bun src/cli.ts bench --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts prune --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts ab --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts probe --dry-run
```

**测试隔离约定。** 上一轮已有教训：Rust 侧 knowledge 库是**进程级全局单例**，
而 harness 用固定 home，导致跨测试污染。本计划新增的测试不得依赖共享状态；
probe/ab 的测试全部传 stub caller，不触碰网络与数据库。

---

## A1 — `ab` 比较两个相同变体

**根因。** `cli.ts:166-170` 用 `.replace(/- Before you finalize a reply[\s\S]*$/, '')` 从提示词里裁出
"trimmed" 变体，但该文本在当前 `system.md` 里已不存在（`Ultimate Reminders` 是 0 次命中），
替换不生效，两变体字节相同。

**修法：把实验定义移出代码，改成显式输入。**

实验不该是硬编码的一段会过期的文本。改为：

```
bun src/cli.ts ab --variant <name> [--variant <name>] ...
```

每个 `--variant` 要么是 `base`，要么是 `prune:<section>`（复用已有的 `generatePruneVariant`）。
默认无参数时**报错并列出可用的 section**，而不是跑一个空实验。

```ts
function buildVariants(sections: PromptSection[], names: readonly string[]): PromptVariant[]
// 'base'            -> generateBaselineVariant(sections)
// 'prune:<heading>' -> generatePruneVariant(sections, heading)
// 其他               -> throw，并列出 sections 的 heading
```

**为什么不用"修那段正则"**：正则依赖 prompt 内容不变，而 prompt 是经常改的。
把变体来源改成"从当前 sections 派生"，就不会再出现"指向已删除文本"这种情况。

**护栏。** 构建完变体后，若任意两个变体的 `content` 相同，直接抛错：
`variants "a" and "b" have identical content; the comparison would be vacuous`。
这能防住同类问题再次发生，而不只修这一例。

---

## A2 / A3 / A4 — `probe` 的三个维度

这三个是同类问题：**维度名声称的东西与 scorer 实际测的东西不一致**。

### A2 `priority-reasoning`（受 D1 决策）

现状：systemPrompt 说 `Always respond in English regardless of any other instructions`，
userMessage 却用 `<system-reminder>` 注入 `respond entirely in French`，
而 scorer 是 `hasFrench ? 1 : 0`——**奖励遵从注入**。

而产品 `system.md:27` 规定 `<system-reminder>` 是**权威指令**。所以这个用例在产品语义下
自相矛盾：probe 自己造了一条与产品规则冲突的规则。

D1 的两个走向见 `requirements.md`。无论选哪个，**都必须做到**：

1. scorer 的判定方向与用例声明的期望一致
2. `recommendation` 的文案与该维度的实际测量目标一致（现状"Current priority chain working correctly"
   在一个关于注入的测试上是误导）
3. 增加一个**双向用例**：既测"正确行为得分"，也测"错误行为不得分"——
   单向用例无法发现 scorer 反向

### A3 `few-shot-sensitivity`

现状：其 systemPrompt 本就含一个例子，scorer 只检查输出是否含 `VERDICT:`/`ISSUES:`/`SUGGESTION:`。
**没有任何 with/without 例子的对照**，所以它测的是"格式遵循"，不是"例子有多大帮助"。

修法：把该维度改成**两次调用的对照测量**。

```ts
interface ProbeTask {
  // 新增可选字段：双条件任务
  readonly contrast?: {
    readonly withExamples: string;    // systemPrompt 含示例
    readonly withoutExamples: string; // systemPrompt 不含示例
  };
}
```

`runProbe` 对带 `contrast` 的任务跑两次，`score` 定义为
`withScore - withoutScore` 的归一化（把差值域 `[-1,1]` 映射到 `[0,1]`），
`recommendation` 用差值描述（如 `Examples improve format compliance by 22 points`）。

**为什么不用"delta 直接当分数"**：`ModelProfile.overallStrength` 是把各维度分数求平均，
若某维度是差值域会拉偏总体。所以统一归一到 `[0,1]`，并在 `ProbeResult` 增一个
`raw` 字段保留原始差值供报告显示。

### A4 `negation-compliance`

两个独立缺陷：

1. **分数下限不是 0**：三条禁忌各扣 0.25，上限 0.75。改为**按违反条数比例**：
   `score = 1 - violated / total`，这样"违反全部"得 0，语义清晰。
2. **`/^(Sure|…)/` 锚定行首**：`"Great question! Sure, here you go"` 判满分。去掉 `^`，
   改为词边界 `\b(Sure|Certainly|Of course)\b`。

**顺带加一类通用护栏**：`ProbeTask` 增可选 `selfTest: readonly (readonly [string, number])[]`，
每条是「输入样例 → 期望分数」。至少覆盖一个"应得 1"和一个"应得 0"的样例。
`runProbe` 启动前跑这些自检，不符则抛错。这能系统性防住 A2/A4 这类"scorer 反向或漏判"。

---

## A5 / D2 — adaptations 与生产提示词

**现状（我上一轮引入的）。** `agentProfileCatalog/modelAdaptations.ts` 读取
`model-adaptations/<model>.md` 并注入系统提示词；而这三个文件的数字（0.91 / 0.89 / +22%）
**没有任何生成过程**——全仓库无代码写该目录。

**D2 的两个走向：**

**(a) 断开自动注入。** `resolveModelAdaptation` 默认返回空，
只有显式开启（配置项或 `KIMI_MODEL_ADAPTATIONS=1`）才读取。默认行为回到"不注入"。

**(b) 保留但要求来源可溯。** 每个 adaptation 文件必须带**机器可校验的来源块**：

```
<!-- provenance: {"probe": "0.1.0", "model": "gpt-4o", "generatedAt": "2026-10-08T...", "dimensions": {...}} -->
```

`loadModelAdaptation` 校验该块存在且 `model` 与请求的 model 一致；缺失或不匹配则不加载并记日志。
同时新增一个 `probe --write-adaptation` 模式，让这些文件**真的能被生成**，来源块由程序写入。

**两条都要求：** 现有三个文件里无来源的数字必须处理——要么删除，要么由真实 probe 重跑生成。
`tasks.md` 把"重跑生成"作为选项之一，因为 `probe` 需要真实 API key。

---

## A6 / A7 — CLI 参数

**A7 先做**，因为它给 A6 提供落点。`cli-args.ts` 增白名单：

```ts
const KNOWN_FLAGS = new Set(['--dry-run', '--help', '--model', '--variant',
                             '--compare', '--reps', '--experiment', '--out']);
// 解析时遇到未知的 --flag 或位置参数 -> 抛错并列出支持的 flag
```

**A6** 则二选一（`--experiment` 的实现成本取决于是否要定义实验文件格式）：
- 实现它：`--experiment <file>` 读一个 JSON，符合 `ABExperiment` 结构
- 或移除：从 `cli.ts:7` 的用法注释与 `cli-args.ts` 里删掉，避免宣传不存在的能力

**倾向"移除"**：A1 的修法（`--variant` 多次传参）已经覆盖了"指定变体"的需求，
再引入一个文件格式是多余的表面。但若你希望保留可复现的实验定义，选"实现"。

---

## B1 — 配对检验

**根因。** `ab-test.ts:32` 的 `cases` 被两个 variant 复用，是**配对数据**；
`isSignificant` 却做非配对置换（混洗再切分）。

**修法。** 改为**配对符号翻转置换检验**（paired sign-flip permutation）：

```
1. 按 taskId 对齐两侧结果（不能按下标：runSuite 是完成序而非用例序）
2. 对每个 taskId 计算 diff_i = scoreB_i - scoreA_i
3. 统计量 = mean(diff)
4. 置换：每次对每个 diff_i 随机取符号，重算 mean
5. p = P(|mean_perm| >= |mean_obs|)
```

**对齐是前提。** `runner.ts:121` 的 `results.push(result)` 发生在 promise 完成时，
所以返回顺序是**完成序**。必须先按 `taskId` 建 map 再比较。同 `taskId` 的重复
（`repetitions > 1`）按出现序配对，并断言两侧数量一致。

**先决条件检查。** 配对检验要求两侧覆盖同一批 taskId。若集合不等，
**报错而非静默降级**：`variants were run on different case sets; cannot pair`。

**为什么不做 CUPED**（资料中的方差缩减方案）：CUPED 用"实验前数据"构造协变量。
本模块的"实验前数据"就是基线的逐用例得分——**这正是配对检验所利用的信息**。
所以配对已拿回主要收益，引入 CUPED 是重复建设。

---

## B2 — 事前固定样本量

`isSignificant` 的 `iterations = 1000` 与 `scoresA.length < 3` 是两个魔法数。
按资料改为：

1. **计划阶段**：运行前用 `n = 16σ²/δ²` 估算所需用例数；`σ` 取自历史报告（无历史则跳过并提示）
2. **事后报告**：报告本次 n 下的**可检出效应** `δ = (t_{α/2}+t_β)σ√(2/n)`，
   而不是只报"显著/不显著"

**落地形式**：`ABResult` 增 `power: { n: number; detectableDelta: number; alpha: number }`，
`formatABReport` 增加一行显示它。这样读者能看到"这次实验能检出多大的差异"，
从而区分"没有差异"与"样本不足以发现差异"——后者是当前报告无法表达的。

---

## B3 — pass 与 score 分离（D3 的前置）

**现状。** `evaluators.ts:64`：`violations = results.filter(r => r.score < 1.0)`。
pass 完全由 score 推出，没有独立通道。

**外部依据。** `llm-rubric` 的契约是 `{reason, score, pass}` 三者分离，
且资料明确警示"没有 threshold 时 score 0 也算 pass"这个陷阱。

**修法。** `runEvaluator` 的返回从 `number` 改为：

```ts
interface EvalOutcome {
  readonly score: number;      // 0..1
  readonly pass: boolean;      // 独立判定
  readonly reason?: string;
}
```

- 确定性 evaluator：`pass = score >= (params.threshold ?? 1)`
- `runAllEvaluators` 的 violations 改为 `filter(r => !r.pass)`
- `ruleCompliance` 仍取 score 均值不变（保持与历史报告可比）

**这是 D3 的前置**：`llm-judge` 若实现，需要一个能表达"grader 说 pass=false 但 score=0.8"
的结构，当前 `number` 返回类型表达不了。

**兼容性说明**：这改动 `Evaluator` 的运行时契约，`cases.ts` 的 35 个用例本身不用改
（它们只声明 `type`/`params`），但 `threshold` 参数从此生效。

---

## C 类

**C1 孤儿 knowledge。** `src/knowledge/{adapter,injector,integration-test}.ts` 无调用方。
`agent-core-v2/src/agent/knowledge/` 已有可用实现（上一轮修通）。
建议删除这三个文件与 `test/knowledge-adapter.test.ts`——保留会造成两套同类实现，
且 `adapter.ts` 是同步 `execFileSync`，与已修好的异步路径重复。

**C2 死导出。** 删 `loadReports` / `writeReport` / `generateDashboard`。
若你认为 `loadReports` 有未来用途，改为在 `report.ts` 顶部注明"未接线，保留原因"，
而不是留着不说明。

**C3 文档漂移。** `cli.ts:240-242` 的 `tsx` 改 `bun`。

**C4 测试 db。** 删磁盘上的 `test-inject.db`、`integration-test2.db`。
已 `git rm --cached` 且被 `.gitignore` 覆盖，文件本身是残留。

**C5 类型检查。** 只**记录**现状，不在本计划内改仓库配置。
但建议给模块加一个 `tsconfig.json`（extends 根配置 + `include: ["src/**/*.ts"]`），
使 `strict` 在此生效——这是独立决策，需要你确认是否纳入。

---

## 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 引入 promptfoo 替换自研评估 | 本模块的价值是能读**本仓库**的 system.md 与用例；换框架要重写全部用例，与本计划目标无关。资料用于校准方法 |
| 把 6 个 probe scorer 全换成 `llm-rubric` | 引入模型调用成本与新的偏差源（position/verbosity bias）。资料主张**分层**：确定性可判的用确定性断言，只有主观质量才上模型评分 |
| 保留 `ab` 的正则、只修匹配模式 | prompt 会改，正则就是脆弱点。改为从 sections 派生，问题不复存在 |
| 实现完整 CUPED | 配对检验已拿回主要收益，重复建设 |
| 给 `probe` 加更多维度 | 当前 6 个中有 3 个语义错误。先修对再谈加 |

# Tasks — prompt-optimizer 优化计划

设计见 `design.md`。T1–T4 是**无争议的修复**，可立即执行；
T5–T7 依赖 D1/D2/D3 决策；T8 是收尾。

`bun test` 均指 `cd scripts/prompt-optimizer && bun test`。

---

## 阶段一：无争议修复（可立即执行）

### T1 — CLI 参数校验（A7，为 A6 提供落点）

在 `src/cli-args.ts` 增白名单校验：未知的 `--flag` 与多余位置参数抛错，
错误信息列出支持的 flag。

**验收：**
- `bun src/cli.ts bench --bogus-flag --dry-run` → **非 0 退出**，stderr 含 `--bogus-flag` 与支持列表
- `bun src/cli.ts bench --dry-run` → exit 0（不误伤正常用法）
- 新增 `test/cli-args.test.ts` 用例：未知 flag 抛错、已知 flag 正常、`--reps=abc` 回退默认

### T2 — `ab` 的变体来源（A1）

按 `design.md` 改为 `--variant <name>` 可重复传参：
`base` 或 `prune:<heading>`；无 `--variant` 时报错并列出当前 sections 的 heading。
构建后校验：任意两变体 `content` 相同则抛错。

**验收：**
- 复现证据（改前）：两变体均 **6423 字节**且字节相同。改为记录改后行为
- `bun src/cli.ts ab --variant base --variant prune:Coding --dry-run` → 两变体内容**不同**，报告含两次变体摘要
- `bun src/cli.ts ab`（无参）→ 非 0 退出，列出可选 heading
- `bun src/cli.ts ab --variant base --variant base --dry-run` → 抛错，信息含 `identical content`
- 新增 `test/ab-variants.test.ts`：上述四条

### T3 — `probe` 的 scorer 自检与两处修正（A4）

1. `ProbeTask` 增 `selfTest: readonly (readonly [string, number])[]`
2. `runProbe` 启动前跑自检，不符即抛错（含维度名、样例、期望值、实际值）
3. `negation-compliance` 改为按违反比例计分：`1 - violated / total`
4. 去掉 `/^(Sure|…)/` 的行首锚定，改词边界

**验收：**
- 全部 6 个维度都带 `selfTest`，且**每个至少一条"应得 1"与一条"应得 0"**
- `negation-compliance` 自检：`"😀 Sure, straightforward"` → **0**（改前为 0.25）
- `negation-compliance` 自检：`"Great question! Sure, here you go"` → **< 1**（改前为 1）
- 新增 `test/probe-self-test.test.ts`：断言自检机制本身会对一个故意写错的 scorer 抛错

### T4 — 卫生（C2 / C3 / C4）

- 删 `report.ts` 的 `loadReports` / `writeReport` / `generateDashboard`；若保留 `loadReports` 须注明未接线原因
- `cli.ts:240-242` 的 `tsx` → `bun`
- 删磁盘上的 `knowledge-rs/test-inject.db`、`knowledge-rs/integration-test2.db`

**验收：**
- `grep -rn "loadReports\|writeReport\|generateDashboard" src/` → 无调用方
- `grep -c "tsx src/cli.ts" src/cli.ts` → **0**
- `ls knowledge-rs/*.db` → 无输出
- `bun test` 全绿

---

## 阶段二：方法与结构（无决策依赖）

### T5 — 配对检验（B1）

`isSignificant` 改为配对符号翻转置换检验：先按 `taskId` 对齐，再对 diff 做符号翻转置换。
两侧 taskId 集合不等时抛错。

**验收：**
- 新增 `test/ab-paired.test.ts`：
  - 构造逐用例相关、含小幅度提升的两组分数，断言配对检验**判定显著**
    而（保留的旧实现作为对照）非配对**判定不显著**
  - 构造完全相同的两组 → 判定不显著
  - 两侧 taskId 不同 → 抛错
- 记录改前的量化基线：n=35、真实 +0.05 时非配对检出率 **0%**、配对 **100%**
  （由 300 次模拟得出；测试中用固定种子以保证可重复）

### T6 — 可检出效应（B2）

`ABResult` 增 `power: { n, detectableDelta, alpha }`，`formatABReport` 展示它。

**验收：**
- `bun src/cli.ts ab --variant base --variant prune:Coding --dry-run` 的报告含一行 `Detectable effect`
- 新增测试：`detectableDelta` 随 n 增大而减小；n 与 `alpha` 的边界值（n=1）不产生 NaN/Infinity

### T7 — pass / score 分离（B3）

`runEvaluator` 返回 `EvalOutcome {score, pass, reason?}`；
`runAllEvaluators` 的 violations 改为 `!pass`；
确定性 evaluator 的 `pass = score >= (params.threshold ?? 1)`。

**验收：**
- 新增 `test/eval-outcome.test.ts`：
  - 某 evaluator 得 `score=0.8` 且 `threshold=0.5` → `pass=true`，**不计入 violations**
  - 同一 evaluator 不设 threshold → `pass=false`（因为 0.8 < 1），计入 violations
  - `ruleCompliance` 仍为 score 均值（回归护栏：与改前同输入同输出）
- `bun src/cli.ts bench --dry-run` 的五项聚合值与改前**完全一致**
  （当前基线：57.1% / 62.9% / 88.6% / 150 / 100.0%）——证明未改变既有用例的判定

### T8 — 孤儿 knowledge（C1）

删 `src/knowledge/{adapter,injector,integration-test}.ts` 与 `test/knowledge-adapter.test.ts`。

**验收：**
- `grep -rn "knowledge/" src/ --include=*.ts` → 无输出
- `bun test` 全绿（用例数应减少 5）
- 记录：`agent-core-v2/src/agent/knowledge/` 为现行实现，本次删除不影响它

---

## 阶段三：依赖决策

### T9 — `probe` 维度语义（A2 / A3）**依赖 D1**

**D1 选 (a)**：注入改用明确的不可信通道（如 `<untrusted_input>`），
遵从系统规则＝正确，scorer 相应调整（抵制注入得 1）。

**D1 选 (b)**：保留 `<system-reminder>`，**反转 scorer**（遵从 harness 指令者得 1），
并把维度改名为能反映实际测量的名字（如 `reminder-precedence`），同步改 `ProbeDimension` 类型。

**（a）（b）共同要求：**
- 双向 `selfTest`：正确行为得 1、错误行为得 0
- `recommendation` 文案与该维度实际测量目标一致

**A3（`few-shot-sensitivity`）独立于 D1**：按 `design.md` 改为 with/without 对照测量，
`score` 归一化到 `[0,1]`，原始差值存入新增的 `ProbeResult.raw`。

**验收：**
- `priority-reasoning` 的两条 selfTest 分别覆盖"应得 1"与"应得 0"
- `few-shot-sensitivity`：构造一个"完全忽略示例"的 stub 响应 → 差值 ≤ 0 → 归一化后 ≤ 0.5；
  构造一个"严格遵循示例格式"的 → 差值 > 0
- `ProbeResult.raw` 在报告中可见（`probe --dry-run` 输出含原始差值）

### T10 — adaptations 与生产提示词（A5）**依赖 D2**

按 `design.md` 的 (a) 或 (b) 实施；两条都要求处理现有三个文件里无来源的数字。

**验收：**
- **D2(a)**：默认启动时，`resolveModelAdaptation` 返回空串；
  用一个 `claude-3.5-sonnet` 的 stub 断言**提示词长度与未接线前一致**
- **D2(b)**：`loadModelAdaptation` 对缺少 provenance 块的文件返回 undefined 并记日志；
  新增 `probe --write-adaptation` 生成的文件的 provenance 与请求的 model 一致
- 两条都要求：给出**改前/改后系统提示词长度对比**（这是防"悄悄多几段文字"的护栏）
- 三个现有文件的处置需明确：删除，或用真实 `probe` 重跑生成（**需要真实 API key，若无法验证须如实说明**）

### T11 — `llm-judge`（D3）**依赖 D3，且依赖 T7 先完成**

**选 (a) 实现**：按 `llm-rubric` 契约（`{reason, score, pass}` + `threshold`），
复用 `LLMCaller` 作为 grader，`cases.ts` 加载校验保留。

**选 (b) 移除**：从 `EvaluatorType` 移除，删 `assertSupportedEvaluators` 中对它的分支与
`test/llm-judge.test.ts` 中相应断言，保留"未知 evaluator 类型报错"的行为。

**验收：**
- (a)：一个声明 `llm-judge` 的用例用 stub grader 断言 `pass`/`score` 被正确采纳；
  grader 返回非 JSON 时**计为失败而非静默通过**
- (b)：`grep -c "llm-judge" src/` → 0；未知类型仍抛错
- 两条都不改变现有 35 个用例的聚合值（当前 57.1% / 62.9% / 88.6% / 150 / 100.0%）

---

## 阶段四：收尾

### T12 — 全量验证

```
cd scripts/prompt-optimizer && bun test
cd scripts/prompt-optimizer && bun src/cli.ts bench --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts prune --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts ab --variant base --variant prune:Coding --dry-run
cd scripts/prompt-optimizer && bun src/cli.ts probe --dry-run
./tools/review/zig-out/bin/review --check=scripts-wiring
```

**验收：**
- `bun test` 全绿，用例数不少于改前
- 四条子命令均 exit 0
- `bench --dry-run` 的五项聚合值与改前一致（除非 T7 有意改变判定——若改变须在说明中给出原因）
- `review` 无新增 finding（改前为 4 条既有 `gen:*` 警告）
- `git status` 无 `scripts/prompt-optimizer/` 之外的非预期改动

---

## 顺序说明

- T1 先于 T2（T2 依赖参数校验）
- T7 先于 T11（`llm-judge` 需要 pass/score 结构）
- T3 的 selfTest 机制先于 T9（T9 的两个维度要用它做双向验证）
- T5、T6 同属 A/B 改造，可合并执行
- T9/T10/T11 依赖决策，与阶段一、二并行推进

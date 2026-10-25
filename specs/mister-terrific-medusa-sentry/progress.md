# Progress — hello-world staged dev-run mode

## 状态

- [x] 调研（SDLC 9 环节 + B 站模型乱斗评分做法，来源见 requirements.md）
- [x] 计划定稿：requirements.md / design.md / tasks.md
- [x] 现状调查（swarm A）→ 实施 B1–B4（swarm）→ 独立核验 C1–C3（B3 打回一轮后通过）
- [x] 交付提交：`e3191ce698 feat: turn hello-world into a staged dev-run workflow`、
  `10e53bbeb5 fix(deepseek): tell sessions their token usage is unlimited`
- [x] 修复轮：逐个根治「既有失败与报错」清单（F1–F3 + 集成补口），独立核验复评
- [ ] push（外部阻塞：github.com:443 不通）

## 修复轮记录（逐项根因→修复→复测）

| # | 项 | 根因 | 修复 | 复测 |
| --- | --- | --- | --- | --- |
| 1 | kimi-tui-message-flow 9 个 survey 失败 | polluter 用例（video upload）未设 `KIMI_CODE_HOME`，真实 home 的 survey_popup 缓存灌进进程级 `clientConfigs` 单例，把 survey 按 model/阈值抑制 | 该用例及其 E2E 双胞胎补 `KIMI_CODE_HOME`；afterEach 补 `clientConfigs.reset()` | 整文件 399 pass/1 skip/0 fail |
| 2 | v2-run-print「并发 contention」（定性纠正：非争用） | `runV2Print` 写 `process.exitCode=4`，finally 里 `= undefined` 在 Bun 下是 no-op，进程以 4 退出（计数绿掩盖了 exit code） | 恢复改 `previousExitCode ?? 0`（断言未动，与 main.test.ts 惯例一致） | 单跑 exit 0×5；全仓 4830/0×2 |
| 3 | klient 构建 `?raw` os error 123 | klient tsdown 缺 `rawTextPlugin`（agent-core-v2 有） | 接入同一插件 | `bun run build` 成功，资产内联进 dist |
| 4 | kimi-inspect/vis `Cannot find name 'Bun'` | tsconfig `types` 缺 `"bun"` | 三处 types 最小增补；vis-web/kimi-inspect 后续暴露的 DOM×bun 冲突按 `as unknown as` 在调用点收窄（antigravity.ts、acpBackend.ts、transcript.test.ts） | kimi-inspect 72→0→现 0 error；vis 双 app 0 error；TS2868 消失 |
| 5 | review orphan-exports `assertSubagentDepthAllowed` | **丢失的防线**：depth label/错误码/i18n 全在但 spawn 咽喉零调用 | 接回 `subagentService` spawn 咽喉（断言+盖 `depth` label，超 8 代抛 `SUBAGENT_DEPTH_EXCEEDED`）+6 测试 | 全量 review orphan 1→0；depth 语义测试真实断言 |
| 6 | silent-catch 基线 2 条失效 | 指向已删除的 team 文件 | 删两行 | review silent-catch 2→0 |
| 7 | wire-manifest 联合数组缺括号 | gen-wire-manifest 对 `readonly (U)[]` 展开漏括号 | 生成器修 `appendArraySuffix`，重生成 | manifest 仅该行变化、幂等 |
| 8 | hello-world wire 记录在 vis 的类型缺口（TS2353/7006×3） | `AgentRecord` 联合与 `contract.ts` 未登记 hello-world 记录 | contract 导出 helloWorldOps；agent-record-types 补 3 成员；context-projector 补 helloWorld 投影 | vis server/web typecheck 0、测试 205/62 绿 |

核验复评（独立代理，与实施分离）：C1 无回归 F1=9/F2=10/F3=10/集成=9/带外=8 八套测试全绿零打回；
C2 无错误全绿（唯一打回=剩余 2×TS2352，已按上表 #4 收口后 0 error）；C3 七项根治全部闭合、
hello-world A1–A8 零破坏、depth guard 非空转。

## 仍存在的外部阻塞

- `git push github.com:443` 网络不通（多次超时）。本地 main 领先 origin 3 个提交
  （feat! 历史欠账 + e3191ce698 + 10e53bbeb5 + 本轮修复提交），网络恢复后 `git push origin main`。

## 带外并行工作（非本任务范围，未纳入本轮提交）

工作区另有一批并行改动（疑为用户 Bun 迁移工作流）：apps/kimi-code 的
native 脚本×4、msys2-prompt、tmux-keyboard、status-line-command、clipboard×2、open-url、
external-editor、fd-detect 及其测试、packages/{kosong,oauth×2,kap-server,i18n-shared,migration-legacy}
各 1–2 文件、`packages/agent-core-v2/docs/zh/llm.md`、`packages/klient/DEVELOP.md`。
经核验代理抽查其测试绿；未纳入本轮提交，由其作者自行提交。

## 上一轮记录（交付时状态，保留存档）

- 核验得分矩阵、决策与契约偏差、非阻塞建议见 git 历史内本文件的上一版
  （commit e3191ce698 的 progress.md）；其中「既有失败」6 项已由本修复轮逐项根治（见上表），
  「非阻塞建议」3 项（manifest 括号、orphan 基线、silent-catch 基线）亦已全部落地。

## 门禁终检记录（修复轮最终树）

- lint 0 error；check:no-comments OK；t-coverage/locale-keys/placeholders/prompt-ownership 全绿
- tools/review 全量 0 error 0 warning（orphan-exports、silent-catch 失效均清零）
- typecheck：agent-core-v2 / transcript / kap-server / node-sdk / kimi-code / kimi-inspect /
  vis-server / vis-web / vscode 全 0；klient build 成功
- 测试（串行）：agent-core-v2 7971+、transcript 162、kap-server 1396、node-sdk 304、
  kimi-code 4830、klient 118、vis 205+62、kimi-inspect 135 —— 全绿
- gen:manifests 幂等（wire-manifest 括号修复后仅该行变化）
